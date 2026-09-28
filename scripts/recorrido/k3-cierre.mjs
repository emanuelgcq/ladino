/**
 * BLOQUE K (3) · el cierre de agosto, ahora sin borradores (con borradores el botón «Cerrar» está deshabilitado, que
 * es la regla): cerrarlo, intentar asentar en agosto por la API (borrador y posteo), reabrir con motivo.
 */
import { abrir, BASE, esperar, estado, guardarEstado, login, nuevaEvidencia, sql } from "./lib.mjs";
import { token, llamar } from "./api.mjs";
const E = estado();
const clic = (loc, t = 6000) =>
  loc.click({ timeout: t }).catch((e) => `NO-CLIC: ${String(e).slice(0, 90)}`);
const r = {};
const cid = E.empresas.E2.id;
const resumen = (x) => ({
  avisos: x.avisos,
  red: x.red.filter((l) => !/treasury\/accounts/.test(l)),
  texto: x.texto.slice(0, 900),
});
const { browser, page, eventos } = await abrir();
const ev = nuevaEvidencia("K", eventos);
await login(page, E.personas.contador, E.clave);
async function cierre() {
  await page.goto(BASE + "/admin/contabilidad");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /^Cierre$/ }));
  await esperar(page, 2000);
}
await cierre();
const fila = page
  .getByRole("row")
  .filter({ hasText: /2026-08/ })
  .first();
r.botonCerrar = await clic(fila.getByRole("button", { name: /Cerrar/ }));
await esperar(page, 900);
await ev(page, "contador-cerrar-agosto-confirmacion");
await clic(page.getByRole("button", { name: /^Cerrar el período$/ }).last());
await esperar(page, 2500);
r.cerrar = resumen(await ev(page, "contador-agosto-cerrado"));
const tk = await token(E.personas.contador, E.clave);
const cuentas = sql(
  `select id, code from public.accounts where company_id='${cid}' and code in ('5.1.05','5.1.06')`,
);
const id = (c) => cuentas.find((x) => x[1] === c)?.[0];
const b = await llamar(tk, cid, "POST", "/v1/journal-entries", {
  company_id: cid,
  posting_date: "2026-08-21",
  description: "Asiento en agosto cerrado (prueba del contador)",
  lines: [
    { account_id: id("5.1.06"), debit: "5" },
    { account_id: id("5.1.05"), credit: "5" },
  ],
});
r.borradorEnCerrado = { status: b.status, json: JSON.stringify(b.json).slice(0, 300) };
if (b.status === 201) {
  const p = await llamar(tk, cid, "POST", `/v1/journal-entries/${b.json.id}/post`, {
    company_id: cid,
  });
  r.postearEnCerrado = { status: p.status, json: JSON.stringify(p.json).slice(0, 300) };
}
await cierre();
const fila2 = page
  .getByRole("row")
  .filter({ hasText: /2026-08/ })
  .first();
r.botonReabrir = await clic(fila2.getByRole("button", { name: /Reabrir/ }));
await esperar(page, 900);
await page
  .getByLabel("Motivo de la reapertura")
  .fill("corto")
  .catch(() => {});
r.reabrirMotivoCorto = {
  habilitado: await page
    .getByRole("button", { name: /^Reabrir el período$/ })
    .last()
    .isEnabled()
    .catch(() => null),
};
await page
  .getByLabel("Motivo de la reapertura")
  .fill("Falta registrar una factura de agosto que llegó tarde.")
  .catch(() => {});
await ev(page, "contador-reabrir-agosto-lleno");
await clic(page.getByRole("button", { name: /^Reabrir el período$/ }).last());
await esperar(page, 2500);
r.reabrir = resumen(await ev(page, "contador-agosto-reabierto"));
await browser.close();
r.enBase = {
  periodos: sql(
    `select year, month, status, coalesce(reopened_reason,'') from public.fiscal_periods where company_id='${cid}' order by year, month`,
  ),
  manuales: sql(
    `select coalesce(entry_number::text,'—'), status, posting_date, description from public.journal_entries where company_id='${cid}' and source_kind='manual' order by created_at`,
  ),
};
guardarEstado({ k3: r });
console.log(JSON.stringify(r, null, 1));

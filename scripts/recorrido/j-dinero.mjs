/**
 * BLOQUE J · MI DINERO — como el dueño.
 *   Tasa: «Traer del BCV»; ¿se puede poner una tasa vieja o manual? (ADR-0064: solo BCV) — por la pantalla y
 *   por la API. Cuentas y saldos. Formas de pago (una nueva). Mover plata entre cuentas. Cierre de caja sin
 *   diferencia (E1, caja en Bs), con diferencia (E1, caja en dólares) y el de una caja en NEGATIVO (E2, «Caja
 *   Bs» quedó en −120.000 por el sobregiro confirmado del bloque D).
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
import { token, llamar } from "./api.mjs";

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
const saldo = (cid, nombre) =>
  sql(`select b.balance::text from public.company_account_balances b join public.company_accounts a on a.id=b.account_id
        where b.company_id='${cid}' and a.name='${nombre}'`)[0]?.[0];
/** La tarjeta de una cuenta en /dinero: el bloque que contiene su nombre y sus botones. */
const tarjeta = (page, nombre) =>
  page
    .locator("div")
    .filter({ has: page.getByText(nombre, { exact: true }) })
    .filter({ has: page.getByRole("button") })
    .last();

async function cerrarCaja(page, ev, etq, cuenta, contado, motivo) {
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  await clic(tarjeta(page, cuenta).getByRole("button", { name: /^Cerrar la caja$/ }));
  await esperar(page, 1000);
  const d = dialogo(page);
  const abierto = await ev(page, `${etq}-abierto`);
  await d.getByLabel(/^Lo que conté/).fill(contado);
  await esperar(page, 600);
  if (motivo)
    await d
      .getByLabel(/^¿De dónde sale la diferencia\?/)
      .fill(motivo)
      .catch(() => {});
  await ev(page, `${etq}-lleno`);
  await clic(d.getByRole("button", { name: /^Cerrar caja$/ }));
  await esperar(page, 2800);
  return { dialogo: abierto.texto.slice(-500), ...resumen(await ev(page, `${etq}-hecho`)) };
}

// ════════════════ E1 ════════════════
{
  const cid = E.empresas.E1.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("J", eventos);
  await login(page, E.personas.duenaE1, E.clave);
  await page.goto(BASE + "/dinero");
  await esperar(page, 3000);
  r.dinero = (await ev(page, "E1-mi-dinero")).texto.slice(0, 1500);
  await clic(page.getByRole("button", { name: /Traer del BCV/ }));
  await esperar(page, 3000);
  r.traerBcv = resumen(await ev(page, "E1-traer-bcv"));

  // ¿tasa vieja o manual? por la API (la pantalla no tiene campo)
  const tk = await token(E.personas.duenaE1, E.clave);
  const ayer = new Date(Date.now() - 28 * 3600e3).toISOString().slice(0, 10);
  const x = await llamar(tk, cid, "POST", "/v1/exchange-rates", {
    company_id: cid,
    from_currency: "USD",
    to_currency: "VES",
    rate: "850.00",
    rate_date: ayer,
    source: "manual",
  });
  r.tasaManualApi = { status: x.status, json: JSON.stringify(x.json).slice(0, 300) };

  // cierre SIN diferencia de la caja en Bs
  const s1 = saldo(cid, "Caja de la bodega");
  r.saldoCajaBs = s1;
  r.cierreSinDif = await cerrarCaja(
    page,
    ev,
    "E1-cierre-caja-bs",
    "Caja de la bodega",
    String(Number(s1).toFixed(2)),
  );
  // cierre CON diferencia de la caja en dólares
  const s2 = saldo(cid, "Caja en dólares");
  r.saldoCajaUsd = s2;
  r.cierreConDif = await cerrarCaja(
    page,
    ev,
    "E1-cierre-caja-usd",
    "Caja en dólares",
    String((Number(s2) - 1).toFixed(2)),
    "Un billete de 1 dólar roto que no aceptaron.",
  );

  // forma de pago nueva
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  await clic(page.getByRole("button", { name: /Agregar forma/ }));
  await esperar(page, 900);
  {
    const d = dialogo(page);
    await d.getByLabel(/^Nombre/).fill("Pago móvil Banesco");
    await elegir(page, d.getByLabel(/^Tipo/), /^Pago móvil$/);
    await elegir(page, d.getByLabel(/^A qué cuenta entra/), /Banesco/);
    await ev(page, "E1-forma-lleno");
    await clic(d.getByRole("button", { name: /^Crear$/ }));
    await esperar(page, 2500);
    r.forma = resumen(await ev(page, "E1-forma-creada"));
  }
  // mover plata de la caja al banco
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  await clic(tarjeta(page, "Caja de la bodega").getByRole("button", { name: /^Mover plata$/ }));
  await esperar(page, 900);
  {
    const d = dialogo(page);
    await elegir(page, d.getByLabel(/^¿A qué cuenta va\?/), /Banesco/);
    await d.getByLabel(/^¿Cuánto/).fill("1000");
    await d.getByLabel(/^¿Por qué\?/).fill("Depósito de lo cobrado hoy");
    await ev(page, "E1-mover-lleno");
    await clic(d.getByRole("button", { name: /^Mover$/ }));
    await esperar(page, 2500);
    r.mover = resumen(await ev(page, "E1-mover-hecho"));
  }
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  r.dineroDespues = (await ev(page, "E1-mi-dinero-despues")).texto.slice(0, 1800);
  await browser.close();
}

// ════════════════ E2 · cerrar una caja en negativo ════════════════
{
  const cid = E.empresas.E2.id;
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("J", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  r.saldoCajaBsE2 = saldo(cid, "Caja Bs");
  r.cierreNegativo = await cerrarCaja(
    page,
    ev,
    "E2-cierre-caja-negativa",
    "Caja Bs",
    "0",
    "La caja está vacía: el pago del café salió de mi bolsillo.",
  );
  await page.goto(BASE + "/dinero");
  await esperar(page, 2500);
  r.dineroE2 = (await ev(page, "E2-mi-dinero")).texto.slice(0, 1800);
  await browser.close();
}

r.enBase = {
  cierres:
    sql(`select c.trade_name, a.name, cc.expected_amount::text, cc.counted_amount::text, (cc.counted_amount - cc.expected_amount)::text, coalesce(cc.reason,'')
                  from public.cash_closings cc join public.company_accounts a on a.id=cc.account_id join public.companies c on c.id=cc.company_id
                 order by cc.created_at`),
  tasas: sql(
    `select rate_date, rate::text, source, company_id is null from public.exchange_rates order by created_at`,
  ),
};
guardarEstado({ j: r });
console.log(JSON.stringify(r, null, 1).slice(0, 16000));

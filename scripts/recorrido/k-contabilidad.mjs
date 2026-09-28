/**
 * BLOQUE K · CONTABILIDAD CON EL CONTADOR — E2.
 *   El contador (contador@) se crea su cuenta y el dueño lo agrega a E2 con el oficio «Contador» (el resto de
 *   usuarios y roles es del bloque N). Con el contador: dónde aterriza; plan de cuentas; diario; asiento manual
 *   DESCUADRADO (¿lo deja guardar la pantalla? ¿y la API?) y cuadrado (borrador → postear); mayor de CxC;
 *   comprobación a hoy y a ayer; cierre: cerrar AGOSTO (un período sin movimientos: cerrar septiembre rompería los
 *   bloques que faltan), asentar en agosto cerrado, reabrir con motivo; estados financieros; la cola de pendientes.
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
const resumen = (x) => ({ avisos: x.avisos, red: x.red, texto: x.texto.slice(0, 1200) });
async function elegir(page, loc, opcion) {
  const a = await clic(loc);
  await esperar(page, 500);
  const b = await clic(page.getByRole("option", { name: opcion }).first());
  return [a, b].filter((x) => typeof x === "string").join(" / ") || "ok";
}
const CONTADOR = E.personas.contador;
const cid = E.empresas.E2.id;

// ── 1 · el contador se crea su cuenta (como en el bloque A) ──
{
  const existe = sql(`select count(*) from auth.users where email='${CONTADOR}'`)[0]?.[0];
  if (existe === "0") {
    const { browser, page, eventos } = await abrir();
    const ev = nuevaEvidencia("K", eventos);
    await page.goto(BASE);
    await esperar(page, 2500);
    await clic(page.getByRole("button", { name: /Crea tu cuenta/ }));
    await esperar(page, 800);
    await page.locator('input[type="email"]').first().fill(CONTADOR);
    const claves = page.locator('input[type="password"]');
    await claves.nth(0).fill(E.clave);
    if ((await claves.count()) > 1) await claves.nth(1).fill(E.clave);
    await page.locator('button[type="submit"]').first().click();
    await esperar(page, 4000);
    r.cuentaContador = { url: page.url(), ...resumen(await ev(page, "contador-cuenta-creada")) };
    await browser.close();
  }
}

// ── 2 · el dueño lo agrega a E2 como Contador ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("K", eventos);
  await login(page, E.personas.duenoE2E3, E.clave);
  await page.goto(BASE + "/admin/configuracion");
  await esperar(page, 2500);
  if ((await page.getByText(CONTADOR).count()) === 0) {
    await clic(page.getByRole("button", { name: /Agregar persona/ }));
    await esperar(page, 900);
    const d = dialogo(page);
    await d.getByLabel(/^Correo/).fill(CONTADOR);
    r.oficio = await elegir(page, d.getByLabel(/^Oficio/), /^Contador/);
    await ev(page, "E2-agregar-contador-lleno");
    await clic(d.getByRole("button", { name: /^Agregar$/ }));
    await esperar(page, 2500);
    r.agregado = resumen(await ev(page, "E2-agregar-contador-hecho"));
  }
  await browser.close();
}

// ── 3 · el contador en E2 ──
{
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("K", eventos);
  await login(page, CONTADOR, E.clave);
  await esperar(page, 2500);
  const aterrizaje = await ev(page, "contador-aterriza");
  r.aterrizaje = {
    url: page.url(),
    texto: aterrizaje.texto.slice(0, 900),
    menu: (aterrizaje.interactivo?.enlaces ?? []).slice(0, 40),
  };

  await page.goto(BASE + "/admin/contabilidad");
  await esperar(page, 3000);
  r.plan = (await ev(page, "contador-plan")).texto.slice(0, 1500);
  await clic(page.getByRole("tab", { name: /^Diario$/ }));
  await esperar(page, 2000);
  r.diario = (await ev(page, "contador-diario")).texto.slice(0, 1800);

  // asiento manual DESCUADRADO (la pantalla) y luego cuadrado
  await clic(page.getByRole("tab", { name: /Asiento manual/ }));
  await esperar(page, 1500);
  await page
    .getByLabel(/^Descripción/)
    .fill("Reclasificación: parte del flete era un faltante de caja (prueba del contador)");
  const lineas = async (datos) => {
    for (const [i, [cuenta, lado, importe]] of datos.entries()) {
      if (i >= (await page.getByLabel("Importe").count()))
        await clic(page.getByRole("button", { name: /Añadir línea/ }));
      await elegir(page, page.getByLabel("Cuenta").nth(i), cuenta);
      await elegir(page, page.getByLabel("Lado").nth(i), lado);
      await page.getByLabel("Importe").nth(i).fill(importe);
    }
  };
  // Cuentas de resultado, a propósito: un asiento manual contra 1.1.01 descuadraría la tesorería (se mira aparte).
  await lineas([
    [/5\.1\.06/, /Débito/, "1000"],
    [/5\.1\.05/, /Crédito/, "900"],
  ]);
  await esperar(page, 800);
  const desc = await ev(page, "contador-asiento-descuadrado");
  r.descuadrado = {
    texto: desc.texto.slice(-700),
    guardarHabilitado: await page
      .getByRole("button", { name: /^Guardar borrador$/ })
      .isEnabled()
      .catch(() => null),
  };
  await page.getByLabel("Importe").nth(1).fill("1000");
  await esperar(page, 800);
  await ev(page, "contador-asiento-cuadrado");
  await clic(page.getByRole("button", { name: /^Guardar borrador$/ }));
  await esperar(page, 2500);
  r.borrador = resumen(await ev(page, "contador-asiento-borrador"));
  await clic(page.getByRole("tab", { name: /^Diario$/ }));
  await esperar(page, 2000);
  await clic(page.getByRole("button", { name: /^Postear$/ }).first());
  await esperar(page, 800);
  await clic(page.getByRole("button", { name: /^Postear el asiento$/ }).last());
  await esperar(page, 2500);
  r.posteado = resumen(await ev(page, "contador-asiento-posteado"));

  // Mayor de CxC
  await clic(page.getByRole("tab", { name: /^Mayor$/ }));
  await esperar(page, 1500);
  await elegir(page, page.getByLabel(/^Cuenta/).first(), /1\.1\.03/);
  await clic(page.getByRole("button", { name: /Consultar|Ver/ }).first());
  await esperar(page, 2500);
  r.mayor = (await ev(page, "contador-mayor-cxc")).texto.slice(0, 2200);

  // Comprobación a hoy y a ayer
  await clic(page.getByRole("tab", { name: /Comprobación/ }));
  await esperar(page, 2500);
  r.comprobacionHoy = (await ev(page, "contador-comprobacion-hoy")).texto.slice(0, 2500);
  const fecha = page.locator('input[type="date"]').first();
  if ((await fecha.count()) > 0) {
    await fecha.fill("2026-09-24");
    await esperar(page, 800);
    await clic(page.getByRole("button", { name: /Consultar|Ver|Calcular/ }).first());
    await esperar(page, 2500);
    r.comprobacionAyer = (await ev(page, "contador-comprobacion-ayer")).texto.slice(0, 2500);
  }

  // Cierre: los períodos; cerrar agosto; asentar en agosto; reabrir con motivo
  await clic(page.getByRole("tab", { name: /^Cierre$/ }));
  await esperar(page, 2500);
  const cierre = await ev(page, "contador-cierre");
  r.cierre = cierre.texto.slice(0, 2500);
  const filaAgosto = page
    .getByRole("row")
    .filter({ hasText: /2026-08|08\/2026|agosto/i })
    .first();
  if ((await filaAgosto.count()) > 0) {
    await clic(filaAgosto.getByRole("button", { name: /Cerrar/ }));
    await esperar(page, 800);
    await clic(page.getByRole("button", { name: /^Cerrar el período$/ }).last());
    await esperar(page, 2500);
    r.cerrarAgosto = resumen(await ev(page, "contador-cerrar-agosto"));
  } else r.cerrarAgosto = "no hay fila de agosto";

  // asentar en agosto (por la API: el formulario también lo permitiría con la fecha)
  const tk = await token(CONTADOR, E.clave);
  const cuentas = sql(
    `select id, code from public.accounts where company_id='${cid}' and code in ('5.1.05','5.1.06') order by code`,
  );
  const x = await llamar(tk, cid, "POST", "/v1/journal-entries", {
    company_id: cid,
    posting_date: "2026-08-20",
    description: "Asiento en un período cerrado (prueba del contador)",
    lines: [
      { account_id: cuentas.find((c) => c[1] === "5.1.06")?.[0], debit: "10" },
      { account_id: cuentas.find((c) => c[1] === "5.1.05")?.[0], credit: "10" },
    ],
  });
  r.asientoEnCerrado = { status: x.status, json: JSON.stringify(x.json).slice(0, 400) };
  const y = await llamar(tk, cid, "POST", "/v1/journal-entries", {
    company_id: cid,
    posting_date: new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10),
    description: "Asiento descuadrado por la API (prueba del contador)",
    lines: [
      { account_id: cuentas.find((c) => c[1] === "5.1.06")?.[0], debit: "10" },
      { account_id: cuentas.find((c) => c[1] === "5.1.05")?.[0], credit: "7" },
    ],
  });
  r.descuadradoApi = { status: y.status, json: JSON.stringify(y.json).slice(0, 400) };

  await page.goto(BASE + "/admin/contabilidad");
  await esperar(page, 2500);
  await clic(page.getByRole("tab", { name: /^Cierre$/ }));
  await esperar(page, 2500);
  const filaAgosto2 = page
    .getByRole("row")
    .filter({ hasText: /2026-08|08\/2026|agosto/i })
    .first();
  if ((await filaAgosto2.getByRole("button", { name: /Reabrir/ }).count()) > 0) {
    await clic(filaAgosto2.getByRole("button", { name: /Reabrir/ }));
    await esperar(page, 800);
    await page
      .getByLabel("Motivo de la reapertura")
      .fill("Falta registrar una factura de agosto que llegó tarde.");
    await ev(page, "contador-reabrir-lleno");
    await clic(page.getByRole("button", { name: /^Reabrir el período$/ }).last());
    await esperar(page, 2500);
    r.reabrir = resumen(await ev(page, "contador-reabrir-hecho"));
  } else r.reabrir = "sin botón Reabrir";

  // Estados financieros
  await clic(page.getByRole("tab", { name: /^Estados$/ }));
  await esperar(page, 3000);
  r.estados = (await ev(page, "contador-estados")).texto.slice(0, 3000);
  await browser.close();
}

r.enBase = {
  periodos: sql(`select * from public.fiscal_periods p where p.company_id='${cid}'`),
  manuales: sql(
    `select entry_number, status, posting_date, description from public.journal_entries where company_id='${cid}' and source_kind='manual' order by created_at`,
  ),
};
guardarEstado({ k: r });
console.log(JSON.stringify(r, null, 1).slice(0, 20000));

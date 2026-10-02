/**
 * Bloque N · Usuarios y roles. Comprobaciones de `pnpm recorrido N` (ver `_app.mjs`).
 *
 * ADR-0068 (el paso interior lo autoriza la operación que lo contiene):
 *   N-01: el cajero no podía vender mercancía (403 de `inventory.move`). Ya no debe reproducir.
 *   N-02: el Dueño invitado a E3 no veía a las personas (403 «a nivel de negocio») ni vendía.
 *   N-04: el administrativo no podía anular (422 con `accounting.entry.reverse` en pantalla).
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("N");

async function productoDe(empresa, nombre) {
  const [fila] = await sql`
    select id from public.products where company_id = ${EMPRESAS[empresa]} and name = ${nombre}`;
  afirmar(fila, `no existe el producto «${nombre}» en ${empresa}`);
  return fila.id;
}

async function depositoDe(empresa) {
  // El principal lo dice la API (`is_default`), leída por el dueño de E2 y E3.
  const r = await pedir(PERSONAS.duenoE2E3, empresa, "GET", "/v1/warehouses");
  const principal = Array.isArray(r.json) ? r.json.find((d) => d.is_default) : undefined;
  afirmar(principal, `${empresa} no tiene depósito principal (${r.status})`);
  return principal.id;
}

/** Venta de contado de UNA unidad, pagada exacta en Bs con el total que cotiza el servidor. */
async function venderUno(correo, empresa, nombre) {
  const producto = await productoDe(empresa, nombre);
  const deposito = await depositoDe(empresa);
  const cot = await pedir(correo, empresa, "POST", "/v1/pos/quote", {
    company_id: EMPRESAS[empresa],
    lines: [{ product_id: producto, quantity: "1" }],
  });
  afirmar(cot.status === 200, `la cotización dio ${cot.status}: ${cot.texto.slice(0, 200)}`);
  // La factura sobre forma libre identifica al adquirente (PA 00071 art. 13.7, ola 2): el
  // «Consumidor final» es solo para recibos. Un cliente del escenario con documento.
  const [cliente] = await sql`
    select id from public.customers
     where company_id = ${EMPRESAS[empresa]} and not is_system and tax_id is not null
       and upper(tax_id) not like 'PEND-%'
     order by created_at limit 1`;
  afirmar(cliente, `no hay cliente identificado en ${empresa}`);
  return pedir(correo, empresa, "POST", "/v1/pos/sales", {
    company_id: EMPRESAS[empresa],
    customer_id: cliente.id,
    warehouse_id: deposito,
    lines: [{ product_id: producto, quantity: "1" }],
    // En bolívares: el efectivo en divisa causa IGTF en E3 (contribuyente especial) y el total
    // en USD no alcanzaría.
    payments: [{ instrument: "efectivo_bs", currency: "VES", amount: cot.json.functional_total }],
  });
}

/** Lo que SOLO produce la venta de verdad: un movimiento de kardex con su documento. */
async function conKardex(r, empresa) {
  const [mov] = await sql`
    select count(*)::int as n from public.inventory_moves
     where company_id = ${EMPRESAS[empresa]} and source_document_id = ${r.json.document.id}`;
  afirmar(mov.n > 0, "la venta no dejó movimiento de inventario con su documento");
}

c.caso("N-01", "cajero@ vende de contado 1 «Pasta caja x20» en E2 → 201 y kardex", async () => {
  const r = await venderUno(PERSONAS.cajero, "E2", "Pasta caja x20");
  afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  await conKardex(r, "E2");
});

c.caso("N-02", "dueno.andina@ en E3 ve a las personas: GET /v1/members → 200", async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E3", "GET", "/v1/members");
  afirmar(r.status === 200, `esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  const correos = (r.json?.members ?? []).map((m) => m.email);
  afirmar(correos.includes(PERSONAS.registraE3), "la lista no trae al Titular (tornillo@)");
});

c.caso("N-02", "dueno.andina@ vende de contado 1 «Cemento gris 42,5 kg» en E3 → 201", async () => {
  const r = await venderUno(PERSONAS.duenoE2E3, "E3", "Cemento gris 42,5 kg");
  afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  await conKardex(r, "E3");
});

c.caso(
  "N-04",
  "administrativo@ anula en E2 una factura sin cobro → 200 y asiento reversed",
  async () => {
    const producto = await productoDe("E2", "Pasta caja x20");
    const deposito = await depositoDe("E2");
    const [cliente] = await sql`
    select id from public.customers
     where company_id = ${EMPRESAS.E2} and legal_name ilike 'Abastos El Sol%' limit 1`;
    afirmar(cliente, "no existe el cliente Abastos El Sol en E2");
    const emitida = await pedir(PERSONAS.administrativo, "E2", "POST", "/v1/pos/sales", {
      company_id: EMPRESAS.E2,
      customer_id: cliente.id,
      warehouse_id: deposito,
      lines: [{ product_id: producto, quantity: "1" }],
    });
    afirmar(
      emitida.status === 201,
      `la emisión dio ${emitida.status}: ${emitida.texto.slice(0, 200)}`,
    );
    const anular = await pedir(
      PERSONAS.administrativo,
      "E2",
      "POST",
      `/v1/invoices/${emitida.json.document.id}/annul`,
      { company_id: EMPRESAS.E2, reason: "Verificación N-04 del recorrido" },
    );
    afirmar(
      anular.status === 200,
      `esperaba 200, llegó ${anular.status}: ${anular.texto.slice(0, 200)}`,
    );
    const [asiento] = await sql`
    select je.status from public.documents d
      join public.journal_entries je on je.id = d.journal_entry_id
     where d.id = ${emitida.json.document.id}`;
    afirmar(asiento?.status === "reversed", `el asiento quedó en ${asiento?.status}`);
  },
);

export default c.correr;

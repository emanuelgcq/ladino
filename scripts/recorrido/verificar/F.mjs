/**
 * Bloque F · Cobros y deudas. Comprobaciones de `pnpm recorrido F` (ver `_app.mjs`).
 *
 * F-11 (ADR-0072 §5): el comprobante de retención soportada lo carga quien cobra
 *   (`ar.retention.register`: dueño, administrativo y cajero; el encargado no cobra, §2.8) y lo corrige el contador
 *   (`ar.retention.correct`). Ya no basta `sales.payment.register`.
 * F-09: tras cargar, la lista salta al período del comprobante (pantalla; se comprueba el código).
 */
import fs from "node:fs";
import { comprobaciones, afirmar, sql } from "./_app.mjs";
import { pedir as pedirIgtf, EMPRESAS as EMP_IGTF, PERSONAS as PER_IGTF } from "./_app.mjs";
import { pedir, EMPRESAS, PERSONAS } from "./_app.mjs";
import { textoDe as textoIgtf, tiene as tieneIgtf } from "./_pdf.mjs";
import * as v0076 from "./_app.mjs";
import * as monedaA from "./_moneda.mjs";

const c = comprobaciones("F");

c.caso("F-11", "quien cobra carga; el contador corrige; el cajero no corrige", async () => {
  const filas = await sql`
    select r.key, rp.permission_key from public.role_permissions rp
      join public.roles r on r.id = rp.role_id and r.tenant_id is null
     where rp.permission_key in ('ar.retention.register', 'ar.retention.correct')`;
  const tiene = (rol, p) => filas.some((f) => f.key === rol && f.permission_key === p);
  for (const rol of ["owner", "back_office", "cashier"]) {
    afirmar(tiene(rol, "ar.retention.register"), `${rol} no carga`);
  }
  afirmar(!tiene("store_manager", "ar.retention.register"), "el encargado carga y no cobra (§2.8)");
  afirmar(
    tiene("accountant", "ar.retention.correct") && tiene("owner", "ar.retention.correct"),
    "nadie corrige",
  );
  afirmar(!tiene("cashier", "ar.retention.correct"), "el cajero corrige");
});

c.caso("F-09", "la carga salta la lista al mes del comprobante", async () => {
  const dec = fs.readFileSync("apps/web/src/pages/libros/Declaraciones.tsx", "utf8");
  afirmar(dec.includes("onCargado={(fecha) => setRango(mesDe(fecha))}"), "la lista no salta");
});

// ── IGTF del especial (ADR-0072 §2; RESPUESTA §2.6) ─────────────────────────────────────────
/** Una venta de caja de E3 con 1,03 USD por Zelle (1 a la venta, 0,03 de IGTF) y el resto fiado. */
async function ventaZelleIgtfE3() {
  const E3i = EMP_IGTF.E3;
  await sql`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    select 'USD', 'VES', 854.46, 'BCV', (now() at time zone 'America/Caracas')::date, now()
     where not exists (
       select 1 from public.exchange_rates
        where from_currency = 'USD' and to_currency = 'VES'
          and rate_date = (now() at time zone 'America/Caracas')::date)`;
  const [w] = await sql`select id from public.warehouses where company_id = ${E3i} limit 1`;
  const [p] = await sql`
    select sb.product_id from public.stock_balances sb
      join public.products pr on pr.id = sb.product_id
     where sb.company_id = ${E3i} and sb.quantity > 1 and pr.status = 'active'
       and pr.name ilike 'tornillo%'
     limit 1`;
  const [cl] = await sql`
    select id from public.customers where company_id = ${E3i} and not is_system
       and status <> 'blocked' order by legal_name limit 1`;
  afirmar(w && p && cl, "E3 no trae depósito, tornillos con existencia o un cliente");
  const r = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/pos/sales", {
    company_id: E3i,
    customer_id: cl.id,
    warehouse_id: w.id,
    lines: [{ product_id: p.product_id, quantity: "1" }],
    payments: [{ instrument: "zelle", currency: "USD", amount: "1.03" }],
  });
  afirmar(r.status === 201, `venta de caja de E3: ${r.status} ${r.texto}`);
  return r.json;
}

c.caso(
  "F-05",
  "en la ficha, 1 USD entregado por Zelle son 0,97 a la factura y 0,03 de IGTF, con su ND por IGTF",
  async () => {
    const v = await ventaZelleIgtfE3();
    const r = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/payments", {
      company_id: EMP_IGTF.E3,
      document_id: v.document.id,
      currency: "USD",
      amount: "1",
      instrument: "zelle",
      igtf_included: true,
    });
    afirmar(r.status === 201, `abono: ${r.status} ${r.texto}`);
    afirmar(r.json.payment.amount === "0.97000000", `abonó ${r.json.payment.amount}, no 0,97`);
    afirmar(r.json.igtf?.amount === "0.03000000", "el IGTF no es 0,03");
    const nd = r.json.igtf_debit_note;
    afirmar(nd && nd.control_display, "el abono posterior no emitió la ND por IGTF con su control");
    const [d] =
      await sql`select status, tax_amount::text as iva from public.documents where id = ${nd.id}`;
    afirmar(d.status === "paid" && Number(d.iva) === 0, "la ND por IGTF no nació pagada y sin IVA");
  },
);

// ── ADR-0076 · la llave es por intento (F-03, F-08) ────────────────────────────────────────────
c.caso(
  "F-03 (ADR-0076)",
  "tras un rechazo, la misma llave con otro cuerpo dice IDEMPOTENCY_BODY_MISMATCH en palabras, nunca «ya se registró»",
  async () => {
    const llave = crypto.randomUUID();
    const primero = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      "/v1/payments",
      {
        company_id: v0076.EMPRESAS.E2,
        document_id: crypto.randomUUID(),
        currency: "VES",
        amount: "150000",
        instrument: "efectivo_ves",
      },
      llave,
    );
    v0076.afirmar(
      primero.status >= 400 && primero.status < 500,
      `el primero dio ${primero.status}`,
    );
    const segundo = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      "/v1/payments",
      {
        company_id: v0076.EMPRESAS.E2,
        document_id: crypto.randomUUID(),
        currency: "VES",
        amount: "50000",
        instrument: "efectivo_ves",
      },
      llave,
    );
    v0076.afirmar(segundo.status === 409, `el segundo dio ${segundo.status}`);
    v0076.afirmar(segundo.json?.code === "IDEMPOTENCY_BODY_MISMATCH", `code ${segundo.json?.code}`);
    v0076.afirmar(
      segundo.json?.person_message ===
        "Esa operación ya se envió con otros datos; vuelve a intentarlo.",
      `dice «${segundo.json?.person_message}»`,
    );
  },
);

c.caso(
  "F-08 (ADR-0076)",
  "tras un rechazo, la misma llave con otro cuerpo dice IDEMPOTENCY_BODY_MISMATCH en palabras, nunca «ya se registró»",
  async () => {
    const llave = crypto.randomUUID();
    const primero = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      `/v1/customer-credits/${"0076f008-0000-4000-8000-000000000001"}/refunds`,
      { company_id: v0076.EMPRESAS.E2, amount: "10", reason: "Reembolso de prueba" },
      llave,
    );
    v0076.afirmar(
      primero.status >= 400 && primero.status < 500,
      `el primero dio ${primero.status}`,
    );
    const segundo = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      `/v1/customer-credits/${"0076f008-0000-4000-8000-000000000001"}/refunds`,
      {
        company_id: v0076.EMPRESAS.E2,
        amount: "10",
        reason: "Reembolso de prueba",
        allow_negative_balance: true,
        overdraft_reason: "Recorrido: se confirma el sobregiro con su motivo",
      },
      llave,
    );
    v0076.afirmar(segundo.status === 409, `el segundo dio ${segundo.status}`);
    v0076.afirmar(segundo.json?.code === "IDEMPOTENCY_BODY_MISMATCH", `code ${segundo.json?.code}`);
    v0076.afirmar(
      segundo.json?.person_message ===
        "Esa operación ya se envió con otros datos; vuelve a intentarlo.",
      `dice «${segundo.json?.person_message}»`,
    );
  },
);

// ── Ola 3 · sin RIF: F-14, el glosario simple en «Te deben» (Cuentas.tsx) ─────────────────────
c.caso(
  "F-14",
  "la empresa sin RIF lee «Te deben», «Cuánto tiempo llevan debiendo» y «Pagado»",
  async () => {
    const cuentas = fs.readFileSync("apps/web/src/pages/ventas/Cuentas.tsx", "utf8");
    for (const palabra of [
      "Te deben",
      "Cuánto tiempo llevan debiendo",
      '"Pagado"',
      "useConFacturas",
    ]) {
      afirmar(cuentas.includes(palabra), `Cuentas.tsx no dice ${palabra}`);
    }
    const badge = fs.readFileSync("apps/web/src/components/FiscalStatusBadge.tsx", "utf8");
    afirmar(badge.includes("Pagado en parte"), "«Abonada» sigue siendo la única palabra");
  },
);

// F-04 (ADR-0075 §5, familia «moneda B»): UNA sola cifra de deuda. La lista de clientes, «Debe hoy» de
// la ficha, la suma de los saldos del estado de cuenta, la antigüedad y la función del servidor dicen
// lo mismo para cada cliente con deuda de E1 y E2.
c.caso(
  "F-04",
  "lista, ficha, saldos del estado de cuenta y antigüedad dan la misma deuda por cliente (E1 y E2)",
  async () => {
    for (const [e, persona] of [
      ["E1", PERSONAS.duenaE1],
      ["E2", PERSONAS.duenoE2E3],
    ]) {
      const deudores = await sql`
        select cu.id, cu.legal_name,
               round(platform.customer_debt_today(cu.company_id, cu.id), 2)::text as deuda
          from public.customers cu
         where cu.company_id = ${EMPRESAS[e]}
           and exists (select 1 from public.documents d
                        where d.customer_id = cu.id and d.status = 'issued'
                          and d.kind in ('invoice', 'receipt', 'debit_note'))
         order by cu.created_at limit 4`;
      afirmar(deudores.length > 0, `${e} no tiene clientes con documentos por cobrar`);
      for (const d of deudores) {
        const estado = await pedir(persona, e, "GET", `/v1/customers/${d.id}/statement`);
        afirmar(
          estado.status === 200,
          `${e} estado de cuenta: ${estado.status} ${estado.texto.slice(0, 160)}`,
        );
        const lista = await pedir(
          persona,
          e,
          "GET",
          `/v1/customers?with_debt=1&per_page=100&search=${encodeURIComponent(d.legal_name)}`,
        );
        const enLista = lista.json?.items?.find((x) => x.id === d.id)?.debt;
        const cifras = {
          funcion: d.deuda,
          lista: enLista,
          ficha: estado.json.total_outstanding,
          antiguedad: estado.json.aging.total,
          porMoneda: estado.json.debt.by_currency
            .reduce((s, x) => s + Math.round(Number(x.functional_today) * 100), 0)
            .toString(),
        };
        const centimos = Math.round(Number(d.deuda) * 100).toString();
        afirmar(
          cifras.lista === d.deuda &&
            cifras.ficha === d.deuda &&
            cifras.antiguedad === d.deuda &&
            cifras.porMoneda === centimos,
          `${e} «${d.legal_name}»: ${JSON.stringify(cifras)}`,
        );
        // Un documento pagado no debe nada: ni un céntimo de residuo.
        const residuos = estado.json.documents.filter(
          (x) => x.status === "paid" && Number(x.balance) !== 0,
        );
        afirmar(
          residuos.length === 0,
          `${e} «${d.legal_name}»: pagados con saldo ${JSON.stringify(residuos)}`,
        );
      }
    }
  },
);

c.caso(
  "F-04",
  "el aviso al cliente dice USD y Bs con la tasa y la fecha, y «Saldo restante» es la deuda",
  async () => {
    const clientes = fs.readFileSync("apps/web/src/pages/clientes/Clientes.tsx", "utf8");
    afirmar(clientes.includes("a la tasa BCV del"), "el WhatsApp no dice la tasa ni la fecha");
    afirmar(
      clientes.includes("estado.data.debt.by_currency"),
      "el WhatsApp no sale de la deuda del servidor",
    );
    const cobrar = fs.readFileSync("apps/web/src/components/CobrarDocumento.tsx", "utf8");
    afirmar(
      !cobrar.includes("amount: resultado.balance"),
      "«Saldo restante» sigue enseñando el saldo contable del cobro",
    );
  },
);

// R-61 (ADR-0075 §8): la reversa de un cobro tiene permiso propio. Sin escribir nada en el escenario:
// el cajero recibe 403 con el permiso nombrado, y el dueño sin motivo recibe 422.
c.caso("R-61", "reversar un cobro: el cajero recibe 403 y el dueño sin motivo, 422", async () => {
  const [pago] = await sql`
    select p.id from public.payments p
     where p.company_id = ${EMPRESAS.E2} and p.supported_retention_id is null
       and not exists (select 1 from public.payment_reversals r where r.payment_id = p.id)
     order by p.created_at limit 1`;
  afirmar(pago, "E2 no tiene cobros");
  const cuerpo = { company_id: EMPRESAS.E2, reason: "Verificación R-61 del recorrido" };
  const cajero = await pedir(
    PERSONAS.cajero,
    "E2",
    "POST",
    `/v1/payments/${pago.id}/reversal`,
    cuerpo,
  );
  afirmar(cajero.status === 403, `cajero: esperaba 403, llegó ${cajero.status}`);
  afirmar(cajero.json?.message?.includes("ar.payment.reverse"), `mensaje: ${cajero.json?.message}`);
  const dueno = await pedir(PERSONAS.duenoE2E3, "E2", "POST", `/v1/payments/${pago.id}/reversal`, {
    company_id: EMPRESAS.E2,
    reason: "corto",
  });
  afirmar(dueno.status === 422, `dueño sin motivo: esperaba 422, llegó ${dueno.status}`);
  const [sigue] = await sql`
    select count(*)::int as n from public.payment_reversals where payment_id = ${pago.id}`;
  afirmar(sigue.n === 0, "la comprobación reversó un cobro del escenario");
});

// ── Moneda A (ADR-0075 §3-4) ─────────────────────────────────────────────────
c.caso(
  "F-02",
  "una factura de E2 en USD cobrada entera en Bs guarda lo saldado en USD y no vuelve a deber con una tasa tardía",
  async () => {
    const { doc, importes, cobro, fila } = await monedaA.ventaUsdCobradaEnBs();
    afirmar(cobro.status === 201, `cobrar en Bs: ${cobro.status} ${cobro.texto.slice(0, 300)}`);
    afirmar(cobro.json.document_status === "paid", `quedó en ${cobro.json.document_status}`);
    afirmar(
      Number(fila.saldado) === Number(importes.usd),
      `el cobro saldó ${fila.saldado} de ${importes.usd} USD`,
    );
    // La «tasa tardía»: otra tasa para HOY guardada después del cobro, dentro de una
    // transacción que se revierte (la tabla de tasas es global).
    let conTardia = null;
    await sql
      .begin(async (tx) => {
        await tx`
          insert into public.exchange_rates
            (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
          values ('USD', 'VES', 999, 'recorrido-tasa-tardia',
                  (now() at time zone 'America/Caracas')::date, now())`;
        [conTardia] = await tx`
          select platform.document_debt_today(${monedaA.E2}, ${doc.id})::text as hoy,
                 platform.document_balance_transaction(${monedaA.E2}, ${doc.id})::text as usd`;
        throw new Error("__revertir__");
      })
      .catch((e) => {
        if (e.message !== "__revertir__") throw e;
      });
    afirmar(conTardia !== null, "no se pudo medir con la tasa tardía");
    afirmar(Number(conTardia.usd) === 0, `con la tasa tardía le quedan ${conTardia.usd} USD`);
    afirmar(
      Number(conTardia.hoy) === 0,
      `con la tasa tardía la factura pagada debe ${conTardia.hoy}`,
    );
  },
);

c.caso("F-15", "esa factura no deja ni un céntimo en cuentas por cobrar del mayor", async () => {
  const { doc, cobro } = await monedaA.ventaUsdCobradaEnBs();
  afirmar(cobro.status === 201, `el cobro no entró: ${cobro.status}`);
  const abierto = await monedaA.abiertoEnMayor("ar", doc.id);
  afirmar(abierto !== null, "el cobro o la factura quedaron en la cola de asientos");
  afirmar(Number(abierto) === 0, `quedan ${abierto} en cuentas por cobrar`);
});

// ── Moneda B, revisión (ADR-0075 §5 y §8; H4, H8, H12) ───────────────────────
// H8: el 403 de la reversa dice el permiso en palabras de persona, no la frase genérica.
c.caso("R-61", "el 403 de reversar un cobro dice QUÉ permiso falta, en palabras", async () => {
  const [pago] = await sql`
    select p.id from public.payments p
     where p.company_id = ${EMPRESAS.E2} and p.supported_retention_id is null
       and not exists (select 1 from public.payment_reversals r where r.payment_id = p.id)
     order by p.created_at limit 1`;
  afirmar(pago, "E2 no tiene cobros");
  const cajero = await pedir(PERSONAS.cajero, "E2", "POST", `/v1/payments/${pago.id}/reversal`, {
    company_id: EMPRESAS.E2,
    reason: "Verificación H8 del recorrido",
  });
  afirmar(cajero.status === 403, `cajero: esperaba 403, llegó ${cajero.status}`);
  afirmar(
    cajero.json?.person_message ===
      "Necesitas el permiso para reversar un cobro. Pídeselo a quien administra el negocio.",
    `mensaje de persona: ${cajero.json?.person_message}`,
  );
});

// H4: ninguna lectura cuenta un cobro reversado. Sin escribir en el escenario: sobre TODOS los
// documentos de las tres empresas, «tiene cobros» de la lista = existe un cobro VIVO.
c.caso("R-61", "«tiene cobros» y lo pagado no cuentan un cobro reversado", async () => {
  for (const e of ["E1", "E2", "E3"]) {
    const persona = e === "E1" ? PERSONAS.duenaE1 : PERSONAS.duenoE2E3;
    const r = await pedir(persona, e, "GET", "/v1/documents?per_page=100");
    afirmar(r.status === 200, `${e}: listar documentos ${r.status}`);
    const ids = r.json.items.map((d) => d.id);
    if (ids.length === 0) continue;
    const vivos = await sql`
      select d.id,
             exists (select 1 from public.payments p
                      where p.document_id = d.id
                        and not exists (select 1 from public.payment_reversals pr
                                         where pr.payment_id = p.id)) as vivo
        from public.documents d where d.id in ${sql(ids)}`;
    const deLaBase = new Map(vivos.map((v) => [v.id, v.vivo]));
    const malos = r.json.items.filter((d) => d.has_payments !== deLaBase.get(d.id));
    afirmar(malos.length === 0, `${e}: has_payments no coincide en ${malos.map((d) => d.id)}`);
  }
});

// H12: la deuda no se cae por una tasa. La función de deuda no lanza: sin tasa de hoy devuelve
// el nominal y NULL en el equivalente (lo prueba pgTAP 110 §11 sin tasas); aquí, que la lista de
// clientes con deuda responde 200 en las tres empresas.
c.caso("F-04", "la lista de clientes con deuda responde 200 en E1, E2 y E3", async () => {
  for (const e of ["E1", "E2", "E3"]) {
    const persona = e === "E1" ? PERSONAS.duenaE1 : PERSONAS.duenoE2E3;
    const r = await pedir(persona, e, "GET", "/v1/customers?with_debt=1&per_page=100");
    afirmar(r.status === 200, `${e}: ${r.status} ${r.texto.slice(0, 200)}`);
  }
});

export default c.correr;

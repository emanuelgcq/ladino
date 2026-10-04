/**
 * Bloque D · Llegada de mercancía. Comprobaciones de `pnpm recorrido D` (ver `_app.mjs`).
 *
 * Ola 3, sin RIF y la llegada: D-01, D-04, D-05, D-06, D-08/D-10, D-09, D-12, D-13 (al final).
 *
 * D-03 (ADR-0076): tras un error, corregir y confirmar con la misma llave ya no dice «ya se
 *   registró con otros datos». El servidor responde IDEMPOTENCY_BODY_MISMATCH en palabras de
 *   persona, y la web estrena llave tras un 4xx (apps/web/src/llave-intento.ts).
 */
import { comprobaciones } from "./_app.mjs";
import * as v0076 from "./_app.mjs";
import * as monedaA from "./_moneda.mjs";

const c = comprobaciones("D");

c.caso(
  "D-03 (ADR-0076)",
  "tras un rechazo, la misma llave con otro cuerpo dice IDEMPOTENCY_BODY_MISMATCH en palabras, nunca «ya se registró»",
  async () => {
    const llave = crypto.randomUUID();
    const primero = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      "/v1/arrivals",
      { company_id: v0076.EMPRESAS.E2, currency: "USD", lines: [] },
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
      "/v1/arrivals",
      { company_id: v0076.EMPRESAS.E2, currency: "VES", lines: [] },
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

// ── Ola 3 · sin RIF y la llegada (D-01, D-04, D-05, D-06, D-08, D-09, D-10, D-12, D-13) ──────
// El escenario final: E1 ya tiene RIF (bloque M), así que lo propio de la empresa sin RIF (sin
// crédito fiscal, la tarjeta) lo prueba `apps/api/test/e2e-llegada-sin-rif.test.ts`; aquí se
// reproduce el REPRODUCIR de cada hallazgo sobre E1 y E2.
const fsSinRif = await import("node:fs");
const fuenteSinRif = (rel) =>
  fsSinRif.readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

/** Un depósito activo y un producto activo sin lotes ni receta de la empresa. */
async function puestoDeLlegada(empresa) {
  const [w] = await v0076.sql`
    select id from public.warehouses where company_id = ${empresa} and status = 'active'
     order by created_at limit 1`;
  const [p] = await v0076.sql`
    select id from public.products
     where company_id = ${empresa} and status = 'active' and kind = 'good'
       and not tracks_lots and not tracks_expiry and not is_composed
     order by created_at limit 1`;
  v0076.afirmar(w !== undefined && p !== undefined, "la empresa no tiene depósito o producto");
  return { deposito: w.id, producto: p.id };
}

async function proveedorSinRif(correo, alias, empresa) {
  const r = await v0076.pedir(correo, alias, "POST", "/v1/suppliers", {
    company_id: empresa,
    legal_name: `Proveedor informal ${Date.now().toString(36)}`,
    tax_id: null,
    supplier_kind: "nacional",
  });
  v0076.afirmar(r.status === 201, `el proveedor sin RIF dio ${r.status}: ${r.json?.message}`);
  return r.json.id;
}

c.caso(
  "D-04",
  "un proveedor sin RIF se guarda; con él, la compra CON factura se rechaza diciendo qué hacer",
  async () => {
    const E2 = v0076.EMPRESAS.E2;
    const prov = await proveedorSinRif(v0076.PERSONAS.duenoE2E3, "E2", E2);
    const { deposito, producto } = await puestoDeLlegada(E2);
    const r = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "POST", "/v1/arrivals", {
      company_id: E2,
      warehouse_id: deposito,
      currency: "VES",
      supplier_id: prov,
      invoice: "present",
      supplier_document_number: `D04-${Date.now().toString(36)}`,
      supplier_control_number: `00-D04${Date.now().toString(36)}`,
      lines: [{ product_id: producto, quantity: "1", unit_amount: "10" }],
    });
    v0076.afirmar(r.status === 422, `dio ${r.status}`);
    v0076.afirmar(
      /necesita el RIF del proveedor/.test(r.json?.message ?? ""),
      `dice «${r.json?.message}»`,
    );
    v0076.afirmar(
      !/No va a haber factura/.test(r.json?.message ?? ""),
      "el mensaje propone sacar la factura del libro (AF3-14)",
    );
  },
);

c.caso(
  "D-01",
  "comprar «No va a haber factura» a un proveedor sin RIF entra (antes: 422 por el tipo o por el RIF)",
  async () => {
    const E1 = v0076.EMPRESAS.E1;
    const prov = await proveedorSinRif(v0076.PERSONAS.duenaE1, "E1", E1);
    const { deposito, producto } = await puestoDeLlegada(E1);
    const r = await v0076.pedir(v0076.PERSONAS.duenaE1, "E1", "POST", "/v1/arrivals", {
      company_id: E1,
      warehouse_id: deposito,
      currency: "VES",
      supplier_id: prov,
      invoice: "none",
      lines: [{ product_id: producto, quantity: "40", amount: "36000" }],
    });
    v0076.afirmar(r.status === 201, `dio ${r.status}: ${r.json?.message}`);
    v0076.afirmar(r.json?.kind === "unsupported", `kind ${r.json?.kind}`);
  },
);

c.caso(
  "D-05",
  "la vista previa enseña base, IVA y total sin registrar nada; «ya incluye IVA» se lo quita el servidor",
  async () => {
    const E2 = v0076.EMPRESAS.E2;
    const { deposito, producto } = await puestoDeLlegada(E2);
    const [prov] = await v0076.sql`
      select id from public.suppliers
       where company_id = ${E2} and supplier_kind = 'nacional' and tax_id is not null
       order by created_at limit 1`;
    const [antes] = await v0076.sql`
      select count(*)::int as n from public.supplier_invoices where company_id = ${E2}`;
    const r = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "POST", "/v1/arrivals/preview", {
      company_id: E2,
      warehouse_id: deposito,
      currency: "VES",
      supplier_id: prov.id,
      invoice: "present",
      supplier_document_number: `D05-${Date.now().toString(36)}`,
      supplier_control_number: `00-D05${Date.now().toString(36)}`,
      prices_include_tax: true,
      lines: [{ product_id: producto, quantity: "2", unit_amount: "116" }],
    });
    v0076.afirmar(r.status === 200, `dio ${r.status}: ${r.json?.message}`);
    v0076.afirmar(Number(r.json.total_amount) === 232, `total ${r.json.total_amount}`);
    // Base + IVA = lo escrito: con alícuota, la base baja; con un producto exento, no cambia.
    v0076.afirmar(
      Math.abs(Number(r.json.subtotal) + Number(r.json.tax_amount) - 232) < 1e-6,
      `base ${r.json.subtotal} + IVA ${r.json.tax_amount} no da 232`,
    );
    const [despues] = await v0076.sql`
      select count(*)::int as n from public.supplier_invoices where company_id = ${E2}`;
    v0076.afirmar(despues.n === antes.n, "la vista previa dejó una factura escrita");
    const web = fuenteSinRif("apps/web/src/pages/negocio/LlegoMercancia.tsx");
    v0076.afirmar(web.includes("/v1/arrivals/preview"), "«¿Todo bien?» no pide la vista previa");
    v0076.afirmar(web.includes("prices_include_tax"), "la pantalla no manda «ya incluye IVA»");
  },
);

c.caso(
  "D-09",
  "la llegada en dólares usa la tasa oficial VIGENTE a su fecha (no más vieja que el margen) y la vista previa dice cuál; sin una vigente, 409 antes de confirmar",
  async () => {
    const E2 = v0076.EMPRESAS.E2;
    const { deposito, producto } = await puestoDeLlegada(E2);
    const [prov] = await v0076.sql`
      select id from public.suppliers
       where company_id = ${E2} and supplier_kind = 'nacional' and tax_id is not null
       order by created_at limit 1`;
    // Cada día de la ventana (hoy y dos atrás): lo que la regla diga —`platform.closing_rate`,
    // la oficial más reciente no posterior y dentro del margen de plataforma— es lo que la vista
    // previa hace, en las dos direcciones. El escenario no tiene tasa propia todos los días.
    const dias = await v0076.sql`
      select d::date::text as d,
             platform.closing_rate(${E2}, 'USD', 'VES', d::date)::text as rate,
             (select f.rate_date::text from platform.rate_for(${E2}, 'USD', 'VES', d::date) f)
               as rate_date
        from generate_series((now() at time zone 'America/Caracas')::date - 2,
                             (now() at time zone 'America/Caracas')::date, interval '1 day') d`;
    for (const dia of dias) {
      const r = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "POST", "/v1/arrivals/preview", {
        company_id: E2,
        warehouse_id: deposito,
        currency: "USD",
        arrived_on: dia.d,
        supplier_id: prov.id,
        invoice: "none",
        lines: [{ product_id: producto, quantity: "1", unit_amount: "10" }],
      });
      if (dia.rate === null) {
        v0076.afirmar(r.status === 409, `${dia.d} sin tasa vigente dio ${r.status}`);
        v0076.afirmar(r.json?.code === "EXCHANGE_RATE_MISSING", `code ${r.json?.code}`);
      } else {
        v0076.afirmar(r.status === 200, `${dia.d} con tasa vigente dio ${r.status}`);
        v0076.afirmar(
          r.json?.fx_rate_date === dia.rate_date && Number(r.json?.fx_rate) === Number(dia.rate),
          `${dia.d}: la vista dice ${r.json?.fx_rate} del ${r.json?.fx_rate_date}, la regla ${dia.rate} del ${dia.rate_date}`,
        );
      }
    }
    // El margen es un DATO y la regla lo respeta: más allá de él no hay tasa que usar.
    const [margen] = await v0076.sql`
      select p.value::int as dias,
             (select max(x.rate_date) from public.exchange_rates x
               where x.company_id is null and x.from_currency = 'USD' and x.to_currency = 'VES')
               as ultima
        from platform.parameters p where p.key = 'closing_rate_max_age_days'`;
    v0076.afirmar(margen !== undefined && margen.ultima !== null, "no hay margen o no hay tasas");
    const [fuera] = await v0076.sql`
      select platform.closing_rate(${E2}, 'USD', 'VES',
               (${margen.ultima}::date + ${margen.dias}::int + 1)) is null as sin_tasa,
             platform.closing_rate(${E2}, 'USD', 'VES',
               (${margen.ultima}::date + ${margen.dias}::int)) is not null as con_tasa`;
    v0076.afirmar(fuera.sin_tasa, "una tasa más vieja que el margen sigue valiendo");
    v0076.afirmar(fuera.con_tasa, "una tasa dentro del margen no vale");
    const dominio = fuenteSinRif("packages/domain/src/arrivals.ts");
    v0076.afirmar(
      dominio.includes("platform.closing_rate(") &&
        dominio.includes("tasaVigenteDeLaLlegada(sql, input, fecha)"),
      "el registro de la llegada no pasa por la tasa vigente",
    );
    const web = fuenteSinRif("apps/web/src/pages/negocio/LlegoMercancia.tsx");
    v0076.afirmar(/faltaTasa \|\|/.test(web), "«Seguir» no se apaga cuando falta la tasa");
    // La pantalla habla de «tasa» (glosario): el nombre técnico se traduce en lib.ts (vistaDeLlegada).
    v0076.afirmar(
      web.includes("vista.data.tasaFecha") &&
        fuenteSinRif("apps/web/src/lib.ts").includes("tasaFecha: r.fx_rate_date ?? null"),
      "«¿Todo bien?» no dice de qué fecha es la tasa",
    );
  },
);

c.caso(
  "D-08 y D-10",
  "«Ya era mía» de hoy entra a cualquier hora y no queda antes de lo ya registrado hoy",
  async () => {
    const E2 = v0076.EMPRESAS.E2;
    const { deposito, producto } = await puestoDeLlegada(E2);
    const r = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "POST", "/v1/arrivals", {
      company_id: E2,
      warehouse_id: deposito,
      currency: "VES",
      lines: [{ product_id: producto, quantity: "1", unit_amount: "100" }],
    });
    v0076.afirmar(r.status === 201, `dio ${r.status}: ${r.json?.message}`);
    const [m] = await v0076.sql`
      select m.occurred_at <= m.created_at as no_futuro,
             m.occurred_at >= coalesce((select max(o.occurred_at) from public.inventory_moves o
                                         where o.company_id = m.company_id
                                           and o.product_id = m.product_id and o.id <> m.id
                                           and o.created_at <= m.created_at), m.occurred_at)
               as en_orden
        from public.inventory_moves m where m.id = ${r.json.moves[0].id}`;
    v0076.afirmar(m.no_futuro, "occurred_at quedó después de created_at");
    v0076.afirmar(m.en_orden, "el movimiento de hoy quedó antes de uno anterior");
  },
);

c.caso("D-06", "«Ya llegó la factura» manda el precio que la persona escribe", async () => {
  const web = fuenteSinRif("apps/web/src/pages/negocio/Compras.tsx");
  v0076.afirmar(
    web.includes("unit_price: (precios[l.id] ?? l.unit_price_transaction)"),
    "el diálogo sigue mandando siempre el precio de la recepción",
  );
});

c.caso(
  "D-12",
  "a la empresa sin RIF no se le ofrece «libro de compras y crédito fiscal»",
  async () => {
    const web = fuenteSinRif("apps/web/src/pages/negocio/LlegoMercancia.tsx");
    v0076.afirmar(web.includes("DETALLE_FACTURA_SIN_RIF"), "la tarjeta no cambia sin RIF");
    v0076.afirmar(web.includes("RESUMEN_FACTURA_SIN_RIF"), "el resumen no cambia sin RIF");
  },
);

c.caso("D-13", "el aviso de sobregiro lleva los importes con formato de dinero", async () => {
  const E2 = v0076.EMPRESAS.E2;
  const { deposito, producto } = await puestoDeLlegada(E2);
  const [prov] = await v0076.sql`
    select id from public.suppliers
     where company_id = ${E2} and supplier_kind = 'nacional' and tax_id is not null
     order by created_at limit 1`;
  const r = await v0076.pedir(v0076.PERSONAS.duenoE2E3, "E2", "POST", "/v1/arrivals", {
    company_id: E2,
    warehouse_id: deposito,
    currency: "VES",
    supplier_id: prov.id,
    invoice: "none",
    lines: [{ product_id: producto, quantity: "1", amount: "999999999" }],
    payment: { instrument: "efectivo_bs" },
  });
  v0076.afirmar(r.status === 409, `dio ${r.status}: ${r.json?.message}`);
  v0076.afirmar(!/\d\.\d{8}/.test(r.json?.message ?? ""), `dice «${r.json?.message}»`);
});

c.caso(
  "D-11",
  "sobregirar exige permiso y motivo: el administrativo recibe 403 con qué hacer, el dueño sin motivo 422, y nada queda escrito",
  async () => {
    const E2 = v0076.EMPRESAS.E2;
    const [cuenta] = await v0076.sql`
      select ca.id, coalesce(b.balance, 0)::text as saldo
        from public.company_accounts ca
        left join public.company_account_balances b on b.account_id = ca.id
       where ca.company_id = ${E2} and ca.is_active and not ca.is_system and ca.currency = 'VES'
       order by ca.created_at limit 1`;
    v0076.afirmar(cuenta !== undefined, "E2 no tiene una cuenta en bolívares");
    const gasto = (extra) => ({
      company_id: E2,
      category: "Alquiler",
      account_id: cuenta.id,
      amount: "999999999.00",
      ...extra,
    });
    const [antes] = await v0076.sql`
      select count(*)::int as n from public.audit_events
       where company_id = ${E2} and event_type = 'treasury.overdraft.confirmed'`;

    const sin = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      "/v1/expenses",
      gasto({}),
    );
    v0076.afirmar(sin.status === 409, `sin confirmar dio ${sin.status}`);
    v0076.afirmar(/con su motivo/.test(sin.json?.message ?? ""), `dice «${sin.json?.message}»`);

    const sinMotivo = await v0076.pedir(
      v0076.PERSONAS.duenoE2E3,
      "E2",
      "POST",
      "/v1/expenses",
      gasto({ allow_negative_balance: true }),
    );
    v0076.afirmar(sinMotivo.status === 422, `el dueño sin motivo dio ${sinMotivo.status}`);

    const otro = await v0076.pedir(
      v0076.PERSONAS.administrativo,
      "E2",
      "POST",
      "/v1/expenses",
      gasto({ allow_negative_balance: true, overdraft_reason: "Me dijeron que lo registrara" }),
    );
    v0076.afirmar(otro.status === 403, `el administrativo dio ${otro.status}`);
    v0076.afirmar(
      otro.json?.person_message ===
        "Esta cuenta no tiene saldo suficiente. Elige otra cuenta o pídele a quien administra que lo registre.",
      `dice «${otro.json?.person_message}»`,
    );

    const [despues] = await v0076.sql`
      select count(*)::int as n,
             (select coalesce(b.balance, 0)::text from public.company_account_balances b
               where b.account_id = ${cuenta.id}) as saldo
        from public.audit_events
       where company_id = ${E2} and event_type = 'treasury.overdraft.confirmed'`;
    v0076.afirmar(despues.n === antes.n, "quedó un acta de sobregiro sin sobregiro");
    v0076.afirmar(
      (despues.saldo ?? "0") === cuenta.saldo ||
        Number(despues.saldo ?? 0) === Number(cuenta.saldo),
      "el saldo cambió",
    );
    const web = fuenteSinRif("apps/web/src/components/sobregiro.tsx");
    v0076.afirmar(
      web.includes("puede(PERMISO_DE_SOBREGIRO)"),
      "la pantalla ofrece sobregirar a cualquiera",
    );
  },
);

// ── Moneda A (ADR-0075 §3-4) ─────────────────────────────────────────────────
c.caso(
  "D-02",
  "E2 paga una factura en USD desde el banco en bolívares: 201, a la tasa del día, y queda pagada",
  async () => {
    const { pago, fila, saldo } = await monedaA.compraUsdPagadaEnBs();
    monedaA.afirmar(
      pago.status === 201,
      `pagar en Bs una factura en USD: esperaba 201, llegó ${pago.status}: ${pago.texto.slice(0, 300)}`,
    );
    monedaA.afirmar(pago.json.invoice_status === "paid", `quedó en ${pago.json.invoice_status}`);
    monedaA.afirmar(
      fila.transaction_currency === "VES" && fila.settled_currency === "USD",
      `el dinero salió en ${fila.transaction_currency} y canceló ${fila.settled_currency}`,
    );
    monedaA.afirmar(
      Number(fila.saldado) === Number(saldo),
      `canceló ${fila.saldado} de ${saldo} USD`,
    );
    monedaA.afirmar(
      Number(fila.salio) === Number(fila.esperado_bs),
      `salieron Bs ${fila.salio}; a la tasa del día eran ${fila.esperado_bs}`,
    );
  },
);

c.caso("D-07", "ese pago deja la cuenta por pagar de la factura en CERO en el mayor", async () => {
  const { factura, pago } = await monedaA.compraUsdPagadaEnBs();
  monedaA.afirmar(pago.status === 201, `el pago no entró: ${pago.status}`);
  const abierto = await monedaA.abiertoEnMayor("ap", factura.id);
  monedaA.afirmar(abierto !== null, "el pago o la factura quedaron en la cola de asientos");
  monedaA.afirmar(Number(abierto) === 0, `quedan ${abierto} en cuentas por pagar`);
});

export default c.correr;

/**
 * Bloque I · Inventario. Comprobaciones de `pnpm recorrido I` (ver `_app.mjs`). ADR-0078.
 *
 * I-01/I-02: la salida con motivo de la lista cerrada se registra (antes moría con 23514) y una sin
 *   motivo se rechaza por el esquema, nombrando el campo.
 * I-11: la merma va a «Pérdidas por mermas y faltantes», con el motivo en la descripción.
 * I-07: el conteo devuelve la diferencia calculada por el servidor.
 * I-06: el kardex de un depósito trae solo ese depósito.
 * I-05: el inactivo con existencia sigue en el inventario.
 * I-12: «por agotarse» no lista inactivos.
 * Y los invariantes que cruzan inventario con contabilidad y libros, en cero.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("I");

/** Una posición de E2 con existencia de sobra, de un producto activo sin lotes. */
async function posicionConExistencia() {
  const [p] = await sql`
    select b.warehouse_id, b.product_id, b.quantity::text as quantity
      from public.stock_balances b
      join public.products p on p.id = b.product_id and p.status = 'active'
                            and p.kind = 'good' and not p.tracks_lots
     where b.company_id = ${EMPRESAS.E2} and b.lot_id is null and b.quantity >= 2
     order by b.quantity desc limit 1`;
  afirmar(p !== undefined, "E2 no tiene una posición con existencia para la prueba");
  return p;
}

c.caso(
  "I-01",
  "una salida por merma se registra con su motivo (antes: 422 por el CHECK)",
  async () => {
    const p = await posicionConExistencia();
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues", {
      company_id: EMPRESAS.E2,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      quantity: "1",
      reason: "merma",
      evidence: "acta verificar I-01",
      reference: `verificar I-01 ${Date.now().toString(36)}`,
    });
    afirmar(r.status === 201, `la salida dio ${r.status}: ${JSON.stringify(r.json)}`);
    afirmar(r.json.exit_reason === "merma", `exit_reason = ${r.json.exit_reason}`);
    // I-11: el asiento va a la cuenta propia de mermas y lleva el motivo.
    const lineas = await sql`
    select s.purpose, e.description from public.journal_entries e
      join public.journal_lines jl on jl.entry_id = e.id
      join public.company_account_settings s
        on s.account_id = jl.account_id and s.company_id = e.company_id and s.effective_to is null
     where e.source_id = ${r.json.id} and e.status = 'posted' and jl.functional_debit > 0`;
    afirmar(
      lineas.length === 1 && lineas[0].purpose === "inventory_shrinkage",
      `el débito fue a ${JSON.stringify(lineas.map((l) => l.purpose))}`,
    );
    afirmar(lineas[0].description.includes("merma"), `descripción: ${lineas[0].description}`);
  },
);

c.caso("I-02", "una salida SIN motivo se rechaza por el esquema y nombra el campo", async () => {
  const p = await posicionConExistencia();
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues", {
    company_id: EMPRESAS.E2,
    warehouse_id: p.warehouse_id,
    product_id: p.product_id,
    quantity: "1",
  });
  afirmar(r.status === 422, `dio ${r.status}`);
  afirmar(JSON.stringify(r.json.details ?? []).includes("reason"), JSON.stringify(r.json));
});

c.caso(
  "I-07",
  "el conteo calcula la diferencia en el servidor y no escribe con preview",
  async () => {
    const p = await posicionConExistencia();
    const [antes] = await sql`
    select count(*)::int as n from public.inventory_moves where company_id = ${EMPRESAS.E2}`;
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/counts", {
      company_id: EMPRESAS.E2,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      counted: "0",
      reason: "verificar I-07",
      preview: true,
    });
    afirmar(r.status === 200, `dio ${r.status}: ${JSON.stringify(r.json)}`);
    afirmar(
      Number(r.json.system_quantity) === Number(p.quantity) &&
        Number(r.json.delta) === -Number(p.quantity) &&
        r.json.move === null,
      JSON.stringify(r.json),
    );
    const [despues] = await sql`
    select count(*)::int as n from public.inventory_moves where company_id = ${EMPRESAS.E2}`;
    afirmar(antes.n === despues.n, "la vista previa escribió un movimiento");
  },
);

// Re-revisión B1 (20261003110200): el faltante de un conteo va a pérdidas y lleva su evidencia.
c.caso("I-07", "un conteo con faltante SIN evidencia se rechaza y no escribe", async () => {
  const p = await posicionConExistencia();
  const [antes] = await sql`
    select count(*)::int as n from public.inventory_moves where company_id = ${EMPRESAS.E2}`;
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/counts", {
    company_id: EMPRESAS.E2,
    warehouse_id: p.warehouse_id,
    product_id: p.product_id,
    counted: "0",
    reason: "verificar I-07 sin evidencia",
  });
  afirmar(r.status === 422, `dio ${r.status}: ${JSON.stringify(r.json)}`);
  afirmar(
    String(r.json.message ?? "").includes("El conteo dio un faltante"),
    JSON.stringify(r.json),
  );
  const [despues] = await sql`
    select count(*)::int as n from public.inventory_moves where company_id = ${EMPRESAS.E2}`;
  afirmar(antes.n === despues.n, "el conteo rechazado escribió un movimiento");
});

c.caso(
  "I-11",
  "ningún hecho de conteo posterior al corte baja existencia sin evidencia",
  async () => {
    const filas = await sql`
      select m.id
        from public.inventory_moves m
       where m.quantity < 0 and m.exit_evidence is null
         and m.created_at >= (select c.since from platform.invariant_cutoffs c
                               where c.invariant = 'count_shortage_evidence')
         and (exists (select 1 from public.journal_entries e
                       where e.source_kind = 'inventory_move' and e.source_id = m.id
                         and e.source_event = 'stock.counted')
              or exists (select 1 from public.journal_generation_queue q
                          where q.source_kind = 'inventory_move' and q.source_id = m.id
                            and q.source_event = 'stock.counted'))`;
    afirmar(filas.length === 0, `faltantes de conteo sin evidencia: ${JSON.stringify(filas)}`);
  },
);

c.caso("I-06", "tras un traslado, el kardex de cada depósito trae solo lo suyo", async () => {
  const p = await posicionConExistencia();
  const [otro] = await sql`
    select id from public.warehouses
     where company_id = ${EMPRESAS.E2} and id <> ${p.warehouse_id} and status = 'active'
     limit 1`;
  afirmar(otro !== undefined, "sin datos: E2 no tiene un segundo depósito activo para trasladar");
  const t = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/transfers", {
    company_id: EMPRESAS.E2,
    from_warehouse_id: p.warehouse_id,
    to_warehouse_id: otro.id,
    product_id: p.product_id,
    quantity: "1",
    reference: `verificar I-06 ${Date.now().toString(36)}`,
  });
  afirmar(t.status === 201, `el traslado dio ${t.status}: ${JSON.stringify(t.json)}`);
  for (const almacen of [p.warehouse_id, otro.id]) {
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      `/v1/inventory/moves?product_id=${p.product_id}&warehouse_id=${almacen}&per_page=200`,
    );
    afirmar(r.status === 200, `dio ${r.status}`);
    afirmar(r.json.items.length > 0, "sin datos: el kardex del depósito vino vacío");
    afirmar(
      r.json.items.every((m) => m.warehouse_id === almacen),
      "el kardex mezcla depósitos",
    );
  }
});

c.caso("I-05", "un producto inactivado con existencia sigue en el inventario", async () => {
  const p = await posicionConExistencia();
  await sql`update public.products set status = 'inactive' where id = ${p.product_id}`;
  try {
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      "/v1/products?with_stock=1&per_page=200",
    );
    afirmar(r.status === 200, `dio ${r.status}`);
    const fila = r.json.items.find((x) => x.id === p.product_id);
    afirmar(fila !== undefined, "el inactivo con existencia no aparece en el inventario");
    afirmar(fila.status === "inactive", `estado ${fila.status}`);
  } finally {
    // La condición se crea para la prueba y se deshace: el escenario sigue igual.
    await sql`update public.products set status = 'active' where id = ${p.product_id}`;
  }
});

c.caso("I-12", "«por agotarse» no lista productos inactivos en E1, E2 ni E3", async () => {
  const [f] = await sql`
    select count(*)::int as n
      from unnest(${Object.values(EMPRESAS)}::uuid[]) as e(id),
           lateral platform.low_stock_products(e.id) l
      join public.products p on p.id = l.product_id
     where p.status <> 'active'`;
  afirmar(f.n === 0, `${f.n} inactivo(s) por agotarse`);
});

c.caso(
  "I-11",
  "invariantes de inventario y libros en cero tras las salidas y retiros",
  async () => {
    for (const [nombre, id] of Object.entries(EMPRESAS)) {
      const [g] = await sql`select diferencia from platform.inventory_ledger_gap(${id})`;
      afirmar(Number(g.diferencia) === 0, `${nombre}: inventory_ledger_gap ${g.diferencia}`);
      const huecos = await sql`select * from platform.inventory_coverage_gaps(${id})`;
      afirmar(huecos.length === 0, `${nombre}: ${huecos.length} movimiento(s) sin asiento`);
      const kardex = await sql`select * from platform.stock_reconciliation(${id})`;
      afirmar(kardex.length === 0, `${nombre}: stock_reconciliation ${kardex.length}`);
      const notas = await sql`select * from platform.withdrawal_note_gaps(${id})`;
      afirmar(notas.length === 0, `${nombre}: withdrawal_note_gaps ${JSON.stringify(notas)}`);
      const libro = await sql`
      select concepto, cuadra, diferencia::text as diferencia
        from platform.book_ledger_reconciliation(${id}, '2000-01-01'::date, current_date + 1)`;
      afirmar(
        libro.every((l) => l.cuadra),
        `${nombre}: book_ledger_reconciliation ${JSON.stringify(libro)}`,
      );
      const discrepancias = await sql`
      select * from platform.book_ledger_discrepancies(${id}, '2000-01-01'::date, current_date + 1)
       -- El lado del DÉBITO es el de los retiros (ADR-0078). El del crédito (compras con residuo de
       -- céntimos en el mayor) es de la familia del céntimo (ADR-0075 §7) y lo mira su bloque.
       where concepto = 'iva_debito_fiscal'`;
      afirmar(
        discrepancias.length === 0,
        `${nombre}: book_ledger_discrepancies ${JSON.stringify(discrepancias)}`,
      );
    }
  },
);

// ── Ola 3 · la llegada: I-03 (= D-14), «¿A qué depósito?» no atrapa al teclado ─────────────────
c.caso("I-03", "en «¿A qué depósito?» Enter elige y avanza, y hay un «Seguir»", async () => {
  const fs = await import("node:fs");
  const web = fs.readFileSync(
    new URL("../../../apps/web/src/pages/negocio/LlegoMercancia.tsx", import.meta.url),
    "utf8",
  );
  const inicio = web.indexOf('paso === "deposito"');
  const paso = web.slice(inicio, web.indexOf('paso === "confirmar"', inicio));
  afirmar(/setDeposito\(d\.id\);\s*avanzar\(\);\s*\}\s*\}\}/.test(paso), "Enter no avanza");
  afirmar(paso.includes("Seguir"), "el paso no tiene «Seguir»");
  afirmar(paso.includes('!== "principal"'), "«Principal Principal» sigue");
});

// ── Ola 5 · el retiro se factura (ADR-0082; AF3-01, AF3-03, AF3-04) ────────────────────────────
c.caso(
  "AF3-03",
  "una salida por uso en el negocio sale del kardex sin factura y sin débito fiscal",
  async () => {
    const p = await posicionConExistencia();
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues", {
      company_id: EMPRESAS.E2,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      quantity: "1",
      reason: "uso_en_negocio",
      evidence: "Destino verificar I: uso en la sede",
    });
    afirmar(
      r.status === 201,
      `la salida no gravada no entró: ${r.status} ${JSON.stringify(r.json)}`,
    );
    afirmar(r.json.exit_reason === "uso_en_negocio", "el motivo no se guardó");
    afirmar((r.json.withdrawal_invoice ?? null) === null, "un motivo no gravado emitió factura");
    const debito = await sql`
      select 1
        from public.journal_entries e
        join public.journal_lines jl on jl.entry_id = e.id
        join public.company_account_settings s
          on s.account_id = jl.account_id and s.company_id = e.company_id
       where e.company_id = ${EMPRESAS.E2} and e.source_id = ${r.json.id}
         and s.purpose = 'iva_debit_fiscal'`;
    afirmar(debito.length === 0, "un motivo no gravado asentó débito fiscal");
  },
);

c.caso("AF3-04", "la evidencia de una pérdida dice algo: «abc» se rechaza", async () => {
  const p = await posicionConExistencia();
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues", {
    company_id: EMPRESAS.E2,
    warehouse_id: p.warehouse_id,
    product_id: p.product_id,
    quantity: "1",
    reason: "rotura",
    evidence: "abc",
  });
  afirmar(r.status === 422, `«abc» pasó como evidencia: ${r.status}`);
  afirmar(
    String(r.json.message ?? "").includes("al menos dos palabras"),
    `el rechazo no dice qué falta: ${JSON.stringify(r.json)}`,
  );
});

c.caso(
  "AF3-01",
  "antes de confirmar, la salida dice qué va a emitir con sus cifras, y ensayarlo no gasta papel",
  async () => {
    const p = await posicionConExistencia();
    const contar = async () => {
      const [x] = await sql`
        select (select count(*)::int from public.inventory_moves
                 where company_id = ${EMPRESAS.E2}) as movimientos,
               (select count(*)::int from public.documents
                 where company_id = ${EMPRESAS.E2}) as documentos,
               (select count(*)::int from public.inventory_withdrawal_notes
                 where company_id = ${EMPRESAS.E2}) as notas,
               coalesce(platform.customer_debt_today(${EMPRESAS.E2}), 0)::text as deuda,
               platform.sales_mode_at(${EMPRESAS.E2}, now()) as modo`;
      return x;
    };
    // La conducta se ejerce con la VISTA PREVIA: el servidor ensaya la salida entera —la misma
    // emisión— y la deshace. No gasta papel del talonario del escenario (la emisión real la
    // prueba el E2E e2e-salidas-inventario).
    const papel = async () => {
      const [x] = await sql`
        select coalesce(sum(next_available), 0)::text as controles
          from public.fiscal_number_ranges where company_id = ${EMPRESAS.E2}`;
      return x.controles;
    };
    const antes = await contar();
    const papelAntes = await papel();
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues/preview", {
      company_id: EMPRESAS.E2,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      quantity: "1",
      reason: "muestra",
    });
    const despues = await contar();
    afirmar(r.status < 500, `la vista previa respondió ${r.status}: ${JSON.stringify(r.json)}`);
    // Ensayar no escribe NADA: ni kardex, ni documento, ni nota, ni deuda, ni un número de control.
    afirmar(
      JSON.stringify(despues) === JSON.stringify(antes),
      `la vista previa escribió: ${JSON.stringify(antes)} → ${JSON.stringify(despues)}`,
    );
    afirmar((await papel()) === papelAntes, "la vista previa gastó un número de control");
    if (r.status !== 200) {
      // Rechazado (sin precio, sin tasa, sin papel…): con mensaje de persona.
      afirmar(
        typeof r.json.message === "string" && r.json.message.length > 20,
        "rechazo sin mensaje",
      );
      return;
    }
    if (antes.modo !== "facturas") {
      afirmar(
        r.json.emits === "nothing" && r.json.why === "sin_rif",
        `una empresa que no factura anunció un documento: ${JSON.stringify(r.json)}`,
      );
      return;
    }
    // Una empresa que factura: el retiro gravado ANUNCIA su factura de retiro, con sus cifras.
    afirmar(
      r.json.emits === "withdrawal_invoice" && r.json.why === "retiro",
      `el retiro de una empresa que factura no anunció su factura: ${JSON.stringify(r.json)}`,
    );
    afirmar(
      typeof r.json.series === "string" && r.json.series.length > 0,
      "la vista previa no dice la serie",
    );
    afirmar(
      /^\d+\.\d{8}$/.test(r.json.subtotal_amount) && Number(r.json.subtotal_amount) > 0,
      `la base del retiro no es un importe positivo: ${r.json.subtotal_amount}`,
    );
    afirmar(
      /^\d+\.\d{8}$/.test(r.json.tax_amount),
      `el IVA no es un importe: ${r.json.tax_amount}`,
    );
    // Y un motivo no gravado anuncia que no emite nada.
    const n = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues/preview", {
      company_id: EMPRESAS.E2,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      quantity: "1",
      reason: "activo_fijo",
      evidence: "Destino verificar I: uso en la sede",
    });
    afirmar(
      n.status === 200 && n.json.emits === "nothing" && n.json.why === "no_gravado",
      `un motivo no gravado anunció un documento: ${n.status} ${JSON.stringify(n.json)}`,
    );
  },
);

// ── Ola 5 · I-04: un producto se vuelve compuesto desde su alta, y venderlo saca sus ingredientes ──
// No deja ningún documento: la venta que se intenta pide MÁS ingrediente del que hay y se rechaza
// entera. Antes del arreglo esa venta se emitía sin mover nada; que ahora diga CUÁL ingrediente
// falta es la prueba de que la venta lee la receta. La venta que sí ocurre (salidas al céntimo,
// devolución parcial, anulación) la ejercita `apps/api/test/e2e-compuestos-y-lotes.test.ts`.
c.caso(
  "I-04",
  "E3 · un compuesto nace desde el alta, guarda sus ingredientes, y sin existencia de uno la caja dice cuál falta",
  async () => {
    // La tasa de hoy, si el escenario no la trae (misma ENTRADA y misma cifra que el bloque E):
    // el costo del ingrediente va en dólares y la venta a crédito mide el límite en dólares.
    // «Si falta» mira la tasa OFICIAL (company_id nulo): la de una empresa no es la del día.
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ladino-e2e-rates'))`;
      await tx`
        insert into public.exchange_rates
          (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
        select 'USD', 'VES', 854.46, 'BCV', (now() at time zone 'America/Caracas')::date, now()
         where not exists (
           select 1 from public.exchange_rates
            where company_id is null
              and from_currency = 'USD' and to_currency = 'VES'
              and rate_date = (now() at time zone 'America/Caracas')::date)`;
    });
    const crear = (cuerpo) =>
      pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/products/simple", {
        company_id: EMPRESAS.E3,
        price: { amount: "3", currency: "USD" },
        ...cuerpo,
      });
    // LOS PRODUCTOS DE ESTA COMPROBACIÓN SON SIEMPRE LOS MISMOS (código fijo): con
    // `--sin-restaurar` no se acumula un trío nuevo ni otra existencia inicial en cada corrida.
    const elDeCodigo = async (sku) => {
      const [p] = await sql`
        select id from public.products where company_id = ${EMPRESAS.E3} and sku = ${sku}`;
      return p?.id ?? null;
    };
    const nombreRelleno = "Relleno del recorrido";
    let hijo = await elDeCodigo("REC-I04-RELLENO");
    if (hijo === null) {
      const ingrediente = await crear({
        sku: "REC-I04-RELLENO",
        name: nombreRelleno,
        initial_stock: { quantity: "1", unit_cost: { amount: "1", currency: "USD" } },
      });
      afirmar(
        ingrediente.status === 201,
        `alta del ingrediente: ${ingrediente.texto.slice(0, 300)}`,
      );
      hijo = ingrediente.json.product.id;
    }
    // Se rechaza y no crea nada: se intenta en cada corrida sin dejar rastro.
    const conExistencia = await crear({
      name: "Compuesto mal del recorrido",
      is_composed: true,
      initial_stock: { quantity: "1", unit_cost: { amount: "1", currency: "USD" } },
    });
    afirmar(
      conExistencia.status === 422 &&
        conExistencia.json.message.includes("no lleva existencia propia"),
      `un compuesto con existencia inicial debía rechazarse: ${conExistencia.status} ${conExistencia.texto.slice(0, 300)}`,
    );
    const nombre = "Arepa del recorrido";
    let id = await elDeCodigo("REC-I04-AREPA");
    if (id === null) {
      const compuesto = await crear({ sku: "REC-I04-AREPA", name: nombre, is_composed: true });
      afirmar(compuesto.status === 201, `alta del compuesto: ${compuesto.texto.slice(0, 300)}`);
      id = compuesto.json.product.id;
    } else {
      // Reutilizado: vuelve a quedar SIN ingredientes, como recién creado (nunca se vendió: la
      // venta de abajo se rechaza siempre). Quitar la marca se lleva la receta; se vuelve a poner.
      for (const valor of [false, true]) {
        const r = await pedir(PERSONAS.duenoE2E3, "E3", "PATCH", `/v1/products/${id}`, {
          company_id: EMPRESAS.E3,
          is_composed: valor,
        });
        afirmar(
          r.status === 200 && r.json.is_composed === valor,
          `dejar el compuesto reutilizado sin ingredientes (${valor}): ${r.status} ${r.texto.slice(0, 300)}`,
        );
      }
    }

    const [w] = await sql`
      select warehouse_id as id from public.stock_balances
       where company_id = ${EMPRESAS.E3} and product_id = ${hijo} and quantity > 0 limit 1`;
    const [cl] = await sql`
      select id from public.customers where company_id = ${EMPRESAS.E3} and not is_system
         and status <> 'blocked' and credit_limit_usd > 0 order by legal_name limit 1`;
    afirmar(w && cl, "E3 no trae la existencia del ingrediente o un cliente con límite de fiado");
    // Lo que hay del ingrediente AHORA (no «1» de memoria): la venta pide siempre más de lo que
    // hay —cada compuesto lleva medio—, sea cual sea la corrida.
    const [hay] = await sql`
      select quantity::text as q from public.stock_balances
       where company_id = ${EMPRESAS.E3} and product_id = ${hijo} and warehouse_id = ${w.id}`;
    const pedidos = String(Math.ceil(Number(hay.q) * 2) + 3);
    const vender = () =>
      pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/pos/sales", {
        company_id: EMPRESAS.E3,
        customer_id: cl.id,
        warehouse_id: w.id,
        lines: [{ product_id: id, quantity: pedidos }],
        due_date: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(
          new Date(Date.now() + 15 * 86_400_000),
        ),
      });

    const sinReceta = await vender();
    afirmar(
      sinReceta.status === 422 &&
        sinReceta.json.message.includes(nombre) &&
        sinReceta.json.message.includes("no tiene ingredientes"),
      `un compuesto sin ingredientes no debía venderse: ${sinReceta.status} ${sinReceta.texto.slice(0, 300)}`,
    );

    const receta = await pedir(PERSONAS.duenoE2E3, "E3", "PUT", `/v1/products/${id}/recipe`, {
      company_id: EMPRESAS.E3,
      lines: [{ child_product_id: hijo, quantity: "0.5", unit_code: "unidad" }],
    });
    afirmar(receta.status === 200, `guardar los ingredientes: ${receta.status} ${receta.texto}`);

    // Los compuestos pedidos llevan más ingrediente del que hay.
    const antes = await sql`
      select count(*)::int as n from public.documents where company_id = ${EMPRESAS.E3}`;
    const sinExistencia = await vender();
    afirmar(
      sinExistencia.status === 409 &&
        sinExistencia.json.code === "NEGATIVE_STOCK" &&
        sinExistencia.json.message.includes(nombreRelleno) &&
        sinExistencia.json.message.includes(nombre),
      `sin existencia del ingrediente, la caja debía decir cuál falta y de qué compuesto: ${sinExistencia.status} ${sinExistencia.texto.slice(0, 400)}`,
    );
    const despues = await sql`
      select count(*)::int as n from public.documents where company_id = ${EMPRESAS.E3}`;
    const [quedo] = await sql`
      select quantity::text as q from public.stock_balances
       where company_id = ${EMPRESAS.E3} and product_id = ${hijo} and warehouse_id = ${w.id}`;
    afirmar(
      despues[0].n === antes[0].n && quedo.q === hay.q,
      `la venta rechazada dejó algo escrito: documentos ${antes[0].n} → ${despues[0].n}, ingrediente ${hay.q} → ${quedo.q}`,
    );

    const [huecos] = await sql`
      select count(*)::int as n from platform.composite_sale_gaps(${EMPRESAS.E3})`;
    afirmar(huecos.n === 0, `composite_sale_gaps de E3 = ${huecos.n}`);
  },
);

// ── Ola 5, tercera ronda del retiro (ADR-0082; AF5-07, AF5-08) ────────────────────────────────
c.caso(
  "AF5-07",
  "una salida sin IVA (uso en el negocio) SIN su nota de destino se rechaza y no escribe",
  async () => {
    const p = await posicionConExistencia();
    const contar = async () => {
      const [x] = await sql`
        select count(*)::int as n from public.inventory_moves where company_id = ${EMPRESAS.E2}`;
      return x.n;
    };
    const antes = await contar();
    for (const destino of [undefined, "abc"]) {
      const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues", {
        company_id: EMPRESAS.E2,
        warehouse_id: p.warehouse_id,
        product_id: p.product_id,
        quantity: "1",
        reason: "activo_fijo",
        ...(destino === undefined ? {} : { evidence: destino }),
      });
      afirmar(r.status === 422, `salió sin destino (${destino}): ${r.status}`);
      afirmar(
        String(r.json.message ?? "").includes("di adónde fue"),
        `el rechazo no pide el destino: ${JSON.stringify(r.json)}`,
      );
    }
    afirmar((await contar()) === antes, "un rechazo dejó un movimiento escrito");
  },
);

c.caso(
  "AF5-08",
  "un retiro que emite factura con fecha de OTRO día se rechaza al ensayarlo: la factura es de hoy",
  async () => {
    const p = await posicionConExistencia();
    // «Ayer» del reloj de la base, que es el que fecha la factura (no RECORRIDO_FECHA).
    const [t] = await sql`
      select to_char((now() - interval '1 day') at time zone 'utc',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ayer`;
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/inventory/issues/preview", {
      company_id: EMPRESAS.E2,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      quantity: "1",
      reason: "consumo_propio",
      occurred_at: t.ayer,
    });
    afirmar(r.status === 422, `un retiro fechado ayer se aceptó: ${r.status}`);
    const mensaje = String(r.json.message ?? "");
    // Dos reglas pueden rechazarlo y las dos son correctas: la del período ya declarado (va
    // antes) o la de la fecha de hoy. Lo que NO puede pasar es que entre.
    afirmar(
      mensaje.includes("lleva la fecha de hoy") || mensaje.includes("ya se declaró"),
      `el rechazo no es por la fecha: ${JSON.stringify(r.json)}`,
    );
  },
);

export default c.correr;

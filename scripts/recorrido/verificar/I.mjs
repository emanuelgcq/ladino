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

export default c.correr;

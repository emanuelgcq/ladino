/**
 * Bloque L · Libros y declaraciones. Comprobaciones de `pnpm recorrido L` (ver `_app.mjs`).
 *
 * L-01 (migración 20260928120000): el libro de ventas firmaba la NC en positivo y la conciliación
 * con el mayor decía «NO cuadra» en E2 y E3. Ya no debe reproducir.
 * L-06: la conciliación trae el detalle (documentos y asientos) y los huecos de cobertura.
 * L-07 / G-10: la factura anulada A-6 de E2 va en el libro con su número e importes en cero.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";
import { pedir as pedirIgtf, EMPRESAS as EMP_IGTF, PERSONAS as PER_IGTF } from "./_app.mjs";

const c = comprobaciones("L");

const cero = (v) => /^-?0*(?:\.0*)?$/.test(String(v));

c.caso(
  "L-01",
  "book_ledger_reconciliation de septiembre cuadra en E2 y E3 (ningún concepto que no cuadre)",
  async () => {
    for (const e of ["E2", "E3"]) {
      const filas = await sql`
        select concepto, libro::text as libro, mayor::text as mayor, en_cola::text as en_cola
          from platform.book_ledger_reconciliation(${EMPRESAS[e]}, '2026-09-01', '2026-09-30')
         where not cuadra`;
      afirmar(
        filas.length === 0,
        `${e}: ${filas.map((f) => `${f.concepto} libro ${f.libro} ≠ mayor ${f.mayor} + cola ${f.en_cola}`).join("; ")}`,
      );
    }
  },
);

c.caso("L-01", "la NC A-1 de E2 sale en platform.sales_book con base e IVA negativos", async () => {
  const [nc] = await sql`
    select base_gravada::text as base, iva_debito::text as iva
      from platform.sales_book(${EMPRESAS.E2}, '2026-09-01', '2026-09-30')
     where kind = 'credit_note' and series = 'A' and document_number = 1`;
  afirmar(nc, "no está la NC A-1 de E2 en el libro de septiembre");
  // Lo que solo produce el arreglo: el signo. Antes eran 478,50 y 6.562,28 positivos.
  afirmar(nc.base.startsWith("-"), `base gravada de la NC: ${nc.base}`);
  afirmar(nc.iva.startsWith("-"), `IVA débito de la NC: ${nc.iva}`);
});

c.caso(
  "L-06",
  "GET /v1/fiscal-books/reports/reconciliation de E2 cuadra, sin discrepancias y con coverage_gaps",
  async () => {
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      "/v1/fiscal-books/reports/reconciliation?from=2026-09-01&to=2026-09-30",
    );
    afirmar(r.status === 200, `esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(r.json?.balanced === true, "la conciliación de E2 no cuadra");
    afirmar(
      Array.isArray(r.json?.discrepancies) && r.json.discrepancies.length === 0,
      `discrepancias: ${JSON.stringify(r.json?.discrepancies)?.slice(0, 200)}`,
    );
    afirmar(Array.isArray(r.json?.coverage_gaps), "la respuesta no trae coverage_gaps");
  },
);

c.caso(
  "L-07",
  "la anulada A-6 de E2 está en el libro con su número e importes en cero",
  async () => {
    const [a6] = await sql`
    select status, base_gravada::text as base, iva_debito::text as iva,
           total_amount::text as total
      from platform.sales_book(${EMPRESAS.E2}, '2026-09-01', '2026-09-30')
     where kind = 'invoice' and series = 'A' and document_number = 6`;
    afirmar(a6, "no está la factura A-6 de E2 en el libro de septiembre");
    afirmar(a6.status === "annulled", `A-6 debía estar anulada; está «${a6.status}»`);
    afirmar(
      cero(a6.base) && cero(a6.iva) && cero(a6.total),
      `importes de A-6: base ${a6.base}, IVA ${a6.iva}, total ${a6.total}`,
    );
  },
);

// ── Ola 2 · L-11: la fuente de los libros es el Reglamento de la LIVA ───────────
c.caso(
  "L-11",
  "la pantalla y el catálogo de formatos citan el Reglamento de la LIVA, no «PA 071 y PA 102»",
  async () => {
    const fs = await import("node:fs");
    const libros = fs.readFileSync(
      new URL("../../../apps/web/src/pages/libros/Libros.tsx", import.meta.url),
      "utf8",
    );
    afirmar(
      !libros.includes("PA 071 y PA 102"),
      "la pantalla de libros sigue citando la PA 071 y la PA 102",
    );
    afirmar(
      libros.includes("Reglamento de la LIVA (arts. 70 a 78)"),
      "la pantalla no cita el Reglamento",
    );
    const [a] = await sql`select name, legal_source, is_official from public.book_format_adapters
                         where code = 'csv_columnas_legales'`;
    afirmar(
      a && /Reglamento de la LIVA/.test(a.name) && !/PA 071/.test(a.name),
      `adaptador: ${a?.name}`,
    );
    afirmar(a.is_official === false, "el CSV no es un formato oficial y no debe decir que lo es");
  },
);

// ── L-12 (ADR-0072 §9): los nombres dicen de quién es la retención ──
c.caso(
  "L-12",
  "«practicamos (a proveedores)» y «nos practicaron (clientes)» en pantalla",
  async () => {
    const fs = await import("node:fs");
    const dec = fs.readFileSync("apps/web/src/pages/libros/Declaraciones.tsx", "utf8");
    const lib = fs.readFileSync("apps/web/src/pages/libros/Libros.tsx", "utf8");
    afirmar(
      dec.includes("Retenciones que nos practicaron (clientes)"),
      "Declaraciones sin el nombre",
    );
    afirmar(lib.includes("Retenciones que practicamos (a proveedores)"), "Libros sin el nombre");
    afirmar(!dec.includes("Retenciones que nos hicieron"), "queda el nombre viejo");
  },
);

// ── Ola 2 · L-04 / L-05 / L-09 (ADR-0072 §7 y §8, migración 20261002120000) ──
c.caso(
  "L-09",
  "la PA 000091 está sembrada con su fuente, y las celdas ⚠ no se ofrecen",
  async () => {
    const [n] = await sql`
      select count(*)::int as total,
             count(*) filter (where review_status = 'pending_review')::int as pendientes
        from public.tax_calendar_entries where legal_norm = 'PA SNAT/2025/000091'`;
    afirmar(n.total === 970, `filas sembradas: ${n.total} (esperaba 970)`);
    // Todas pendientes desde 20261002120200 (H11): el terminal del RIF está en duda (P-10.2).
    afirmar(n.pendientes === 970, `pendientes de cotejo: ${n.pendientes} (esperaba 970)`);
    // E3 es especial de terminal 6: el calendario le aplica, pero no se ofrece ninguna fecha
    // hasta el cotejo; las de octubre se cuentan como pendientes.
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      "/v1/fiscal-declarations/calendar?from=2026-10-01&to=2026-10-31",
    );
    afirmar(r.status === 200, `esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(r.json?.rif_terminal === 6, `terminal de E3: ${r.json?.rif_terminal}`);
    afirmar(r.json?.applies === true, "a E3 (especial) el calendario debía aplicarle");
    afirmar(
      Array.isArray(r.json?.items) && r.json.items.length === 0,
      `se ofrecen fechas pendientes de cotejo: ${JSON.stringify(r.json?.items)?.slice(0, 200)}`,
    );
    afirmar(r.json?.pending_review > 0, "las fechas de octubre debían contarse como pendientes");
  },
);

c.caso(
  "L-04",
  "a E3 (especial) se le propone la quincena y el mes completo se rechaza con sus dos quincenas",
  async () => {
    const p = await pedir(
      PERSONAS.duenoE2E3,
      "E3",
      "GET",
      "/v1/fiscal-declarations/iva-periods/proposal",
    );
    afirmar(p.status === 200, `propuesta: ${p.status} ${p.texto.slice(0, 200)}`);
    afirmar(p.json?.periodicity === "quincenal", `periodicidad propuesta: ${p.json?.periodicity}`);
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/fiscal-declarations/iva-periods", {
      company_id: EMPRESAS.E3,
      period_from: "2026-10-01",
      period_to: "2026-10-31",
    });
    afirmar(r.status === 422, `el mes de octubre debía dar 422; llegó ${r.status}`);
    afirmar(
      /por quincena/.test(r.json?.message ?? "") &&
        (r.json?.message ?? "").includes("del 01-10-2026 al 15-10-2026") &&
        (r.json?.message ?? "").includes("del 16-10-2026 al 31-10-2026"),
      `mensaje: ${r.json?.message}`,
    );
    const fs = await import("node:fs");
    const dec = fs.readFileSync("apps/web/src/pages/libros/Declaraciones.tsx", "utf8");
    afirmar(!dec.includes("mesLocalAnterior"), "la pantalla sigue calculando el mes anterior");
  },
);

c.caso(
  "L-05",
  "el arrastre de E3 sale en dos cifras: 34.667,30 de crédito y 2.688,92 de retenciones",
  async () => {
    const [x] = await sql`
      select excedente_siguiente::text as credito,
             retenciones_acumuladas_por_descontar::text as retenciones
        from platform.recompute_iva_period(${EMPRESAS.E3}, '2026-09-01', '2026-09-30', 0, 0)`;
    afirmar(!cero(x.retenciones), `retenciones por descontar: ${x.retenciones}`);
    // Lo que solo produce el arreglo: antes salía una sola cifra de 37.356,224768.
    afirmar(
      x.credito.startsWith("34667.30") && x.retenciones.startsWith("2688.92"),
      `crédito ${x.credito}, retenciones ${x.retenciones}`,
    );
  },
);

c.caso(
  "L-15",
  "la quincena del IGTF la da el servidor: /v1/igtf/status trae la quincena en curso",
  async () => {
    const st = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "GET", "/v1/igtf/status");
    const [q] = await sql`
    with d as (select (now() at time zone 'America/Caracas')::date as d)
    select (case when extract(day from d) <= 15 then date_trunc('month', d)::date
                 else date_trunc('month', d)::date + 15 end)::text as desde,
           (case when extract(day from d) <= 15 then date_trunc('month', d)::date + 14
                 else (date_trunc('month', d) + interval '1 month - 1 day')::date end)::text as hasta
      from d`;
    afirmar(
      st.json?.fortnight?.from === q.desde && st.json.fortnight.to === q.hasta,
      `quincena: ${st.texto}`,
    );
  },
);

c.caso(
  "L-03",
  "el TXT de retenciones de E3 del mes sigue los 16 campos de P-7 (RIF sin guiones, fecha AAAA-MM-DD, comprobante de 14)",
  async () => {
    // Una compra de E3 con retención automática (H-01) para que el TXT no salga vacío.
    const [base] = await sql`
      select i.supplier_id, l.product_id
        from public.supplier_invoices i
        join public.supplier_invoice_lines l on l.supplier_invoice_id = i.id
       where i.company_id = ${EMPRESAS.E3} and i.supplier_document_number = 'F-89002'
       limit 1`;
    afirmar(base, "no está F-89002 en E3");
    const [hoy] = await sql`
      select (now() at time zone 'America/Caracas')::date::text as d,
             to_char(date_trunc('month', (now() at time zone 'America/Caracas')), 'YYYY-MM-DD') as desde`;
    const run = Date.now().toString(36);
    const f = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/supplier-invoices", {
      company_id: EMPRESAS.E3,
      supplier_id: base.supplier_id,
      supplier_document_number: `L03-${run}`,
      supplier_control_number: `00-L${run}`,
      invoice_date: hoy.d,
      currency: "VES",
      lines: [{ product_id: base.product_id, quantity: "1", unit_price: "1000" }],
    });
    afirmar(f.status === 201, `registrar: ${f.status} ${f.texto.slice(0, 200)}`);
    const r = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/fiscal-books/export", {
      company_id: EMPRESAS.E3,
      book_kind: "retenciones_iva",
      period_from: hoy.desde,
      period_to: hoy.d,
      format_code: "txt_retenciones_iva",
      timezone: "America/Caracas",
    });
    afirmar(r.status === 201, `exportar: ${r.status} ${r.texto.slice(0, 200)}`);
    const linea = r.json.content.split("\r\n").find((l) => l.includes(`L03-${run}\t`));
    afirmar(linea, "la compra no está en el TXT del mes");
    const campos = linea.split("\t");
    // Lo que solo produce el arreglo: 16 campos (antes 17), RIF sin guiones, fecha ISO, campo 4 «C».
    afirmar(campos.length === 16, `campos: ${campos.length} (antes del arreglo, 17)`);
    afirmar(/^[JVEGPC]\d{9}$/.test(campos[0]), `RIF del agente: ${campos[0]}`);
    afirmar(campos[2] === hoy.d, `fecha: ${campos[2]}`);
    afirmar(campos[3] === "C" && campos[4] === "01", `C/V y tipo: ${campos[3]} ${campos[4]}`);
    afirmar(!campos[5].includes("-"), `RIF del proveedor: ${campos[5]}`);
    afirmar(/^\d{14}$/.test(campos[12]), `comprobante: ${campos[12]}`);
    afirmar(campos[10] === "120.00", `IVA retenido: ${campos[10]}`);
  },
);

// ── L-10 (ola 4): cada libro ofrece solo sus formatos ───────────────────────
c.caso(
  "L-10",
  "el servidor rechaza el TXT de retenciones para el libro de ventas (422) y no deja generación",
  async () => {
    const [antes] = await sql`
      select count(*)::int as n from public.fiscal_book_runs where company_id = ${EMPRESAS.E2}`;
    const r = await pedir(PERSONAS.contador, "E2", "POST", "/v1/fiscal-books/export", {
      company_id: EMPRESAS.E2,
      book_kind: "ventas",
      period_from: "2026-09-01",
      period_to: "2026-09-30",
      format_code: "txt_retenciones_iva",
      timezone: "America/Caracas",
    });
    afirmar(r.status === 422, `esperaba 422, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    // Lo que solo dice ESTE rechazo (no la validación genérica del cuerpo).
    afirmar(
      r.json?.message?.includes("no sirve para el libro de ventas"),
      `mensaje: ${r.json?.message}`,
    );
    const [despues] = await sql`
      select count(*)::int as n from public.fiscal_book_runs where company_id = ${EMPRESAS.E2}`;
    afirmar(despues.n === antes.n, "el rechazo dejó una generación registrada");
  },
);

c.caso("L-10", "el selector de la pantalla filtra el catálogo por el libro elegido", async () => {
  const fs = await import("node:fs");
  const fuente = fs.readFileSync(
    new URL("../../../apps/web/src/pages/libros/Libros.tsx", import.meta.url),
    "utf8",
  );
  afirmar(
    /f\.book_kind === "todos" \|\| f\.book_kind === kind/.test(fuente),
    "Libros.tsx no filtra los formatos por book_kind",
  );
  afirmar(
    /options=\{formatosDelLibro\.map/.test(fuente) &&
      !/options=\{\(formatos\.data \?\? \[\]\)\.map/.test(fuente),
    "el selector sigue listando el catálogo entero",
  );
  // Y el catálogo sigue diciendo de qué libro es cada formato: sin eso el filtro no mide nada.
  const [t] = await sql`
    select book_kind from public.book_format_adapters where code = 'txt_retenciones_iva'`;
  afirmar(t?.book_kind === "retenciones_iva", `txt_retenciones_iva es de: ${t?.book_kind}`);
});

export default c.correr;

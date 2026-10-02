/**
 * Bloque L · Libros y declaraciones. Comprobaciones de `pnpm recorrido L` (ver `_app.mjs`).
 *
 * L-01 (migración 20260928120000): el libro de ventas firmaba la NC en positivo y la conciliación
 * con el mayor decía «NO cuadra» en E2 y E3. Ya no debe reproducir.
 * L-06: la conciliación trae el detalle (documentos y asientos) y los huecos de cobertura.
 * L-07 / G-10: la factura anulada A-6 de E2 va en el libro con su número e importes en cero.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

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

export default c.correr;

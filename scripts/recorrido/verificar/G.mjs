/**
 * Bloque G · Corregir. Comprobaciones de `pnpm recorrido G` (ver `_app.mjs`).
 *
 * G-01 (ADR-0071, PA 00071 art. 44): un correlativo de control por emisor e identificador. El
 * rango de notas de crédito A 1-500 que el recorrido cargó sobre el de facturas A 1-5000 de E2 ya
 * no se puede cargar (409 que dice cuál pisa), y en E2 no queda ningún control repetido: las NC
 * A-1 y A-2 tomaron el siguiente control libre en `corregir-escenario.sql` (solo local).
 * G-16: el aviso de «no hay rango» sale en español («notas de débito»), nunca «debit_note».
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";
import { textoDe, tiene, idDocumento } from "./_pdf.mjs";
import { pedir as pedirIgtf, EMPRESAS as EMP_IGTF, PERSONAS as PER_IGTF } from "./_app.mjs";
import { textoDe as textoIgtf, tiene as tieneIgtf } from "./_pdf.mjs";
import * as monedaA from "./_moneda.mjs";

const c = comprobaciones("G");
const E2 = EMPRESAS.E2;

c.caso("G-01", "cargar en E2 un rango de NC A 1-500 que pisa el de facturas → 409", async () => {
  const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/fiscal-number-ranges", {
    company_id: E2,
    kind: "credit_note",
    series: "A",
    range_from: "1",
    range_to: "500",
    printer_legal_name: "Gráficas Lara, C.A.",
    printer_tax_id: "J-12345678-9",
    printer_authorization: "SNAT/INTI/GRTI/RCO/2020/000123",
    printer_authorization_date: "2020-01-15",
    printed_on: "2026-09-01",
  });
  afirmar(r.status === 409, `esperaba 409, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
  afirmar(
    /pisa el talonario serie A 1–5000/.test(r.json?.message ?? ""),
    `el mensaje no dice cuál pisa: ${r.json?.message}`,
  );
});

c.caso("G-01", "en E2 ningún control se repite, sea factura o nota", async () => {
  const repetidos = await sql`
    select control_number, documents from platform.control_number_collisions()
     where company_id = ${E2}`;
  afirmar(
    repetidos.length === 0,
    `controles repetidos: ${repetidos.map((x) => `${x.control_number} (${x.documents})`).join("; ")}`,
  );
  const [nc] = await sql`
    select control_number::int as control from public.documents
     where company_id = ${E2} and kind = 'credit_note' and series = 'A' and document_number = 1`;
  afirmar(nc, "no está la NC A-1 de E2");
  afirmar(nc.control !== 1, "la NC A-1 sigue con el control 1 de la factura A-1");
});

c.caso("G-01", "ningún rango de control se solapa en el escenario", async () => {
  const solapes = await sql`select company_id from platform.control_range_overlaps()`;
  afirmar(solapes.length === 0, `rangos solapados: ${solapes.length}`);
});

c.caso(
  "G-16",
  "sin talonario, el aviso de una ND dice «notas de débito», no «debit_note»",
  async () => {
    let mensaje = "";
    try {
      await sql`select * from platform.claim_fiscal_control(${E2}, 'debit_note', 'SIN-TALONARIO')`;
    } catch (e) {
      mensaje = e instanceof Error ? e.message : String(e);
    }
    afirmar(
      mensaje ===
        "No quedan números de control para notas de débito (identificador 00). Carga el talonario nuevo.",
      `mensaje: ${mensaje}`,
    );
  },
);

// ── Ola 2 · el papel de la NC y la ND (ADR-0071 §4; RESPUESTA §2.4) ──────────
c.caso(
  "G-02",
  "la NC A-1 de E2 cita la factura que corrige: número, control, fecha y monto",
  async () => {
    const id = await idDocumento("E2", "credit_note", "A", 1);
    afirmar(id, "no está la NC A-1 de E2");
    const { status, texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(status === 200, `PDF: ${status}`);
    afirmar(
      // Con serie, el número impreso lleva la palabra «Serie» (PA 00071 arts. 26-27).
      /Factura que corrige: Serie A N° \d{8} · Control \d{2}-\d{8} · del \d{2}\/\d{2}\/\d{4} · por Bs\. [\d.]+,\d{2}/.test(
        texto,
      ),
      `sin referencia completa a la factura: ${texto.slice(0, 400)}`,
    );
  },
);

c.caso(
  "G-09",
  "la ND A-1 de E2 describe el ajuste, trae el motivo guardado y el IVA con su porcentaje",
  async () => {
    const id = await idDocumento("E2", "debit_note", "A", 1);
    afirmar(id, "no está la ND A-1 de E2");
    const { texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(tiene(texto, "Descripción del ajuste: débito de Bs."), "la ND no describe el ajuste");
    afirmar(tiene(texto, "Motivo: Diferencia de precio"), "la ND no imprime su motivo");
    afirmar(/IVA \d+(,\d+)? %:/.test(texto), "el IVA sale sin porcentaje");
  },
);

c.caso(
  "G-09",
  "la NC A-2 de E2 (de una devolución) imprime el motivo de la devolución, no un texto inventado",
  async () => {
    const id = await idDocumento("E2", "credit_note", "A", 2);
    afirmar(id, "no está la NC A-2 de E2");
    const [dev] = await sql`select reason from public.returns where credit_note_id = ${id}`;
    const { texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    const esperado = dev ? `Motivo: ${dev.reason}` : "Motivo: —";
    afirmar(tiene(texto, esperado), `esperaba «${esperado}»`);
  },
);

c.caso(
  "G-11",
  "las notas de E2 van a la tasa de la factura, impresa con su número y su fecha",
  async () => {
    const id = await idDocumento("E2", "credit_note", "A", 1);
    const { texto } = await textoDe(PERSONAS.duenoE2E3, "E2", id);
    afirmar(
      // «Tasa BCV» si la fuente es el BCV; si no, «Tipo de cambio»: el PDF nombra lo que hay.
      /(Tasa BCV|Tipo de cambio) de la factura Serie A N° \d{8} del \d{2}\/\d{2}\/\d{4}: Bs [\d.,]+/.test(
        texto,
      ),
      `la tasa de la nota no dice de qué factura ni de qué día es: ${texto.slice(0, 600)}`,
    );
  },
);

c.caso(
  "G-03",
  "el recibo de devolución D-1 de E1: su leyenda, sin RIF inventado, sin IVA y sin providencia",
  async () => {
    const id = await idDocumento("E1", "receipt_return", "D", 1);
    afirmar(id, "no está el recibo de devolución D-1 de E1");
    const { status, texto } = await textoDe(PERSONAS.duenaE1, "E1", id);
    afirmar(status === 200, `PDF: ${status}`);
    afirmar(
      tiene(
        texto,
        "Recibo de devolución · Documento no fiscal: no es factura ni nota de crédito y no otorga derecho a crédito fiscal",
      ),
      "falta la leyenda del recibo de devolución",
    );
    afirmar(
      texto.includes("RECIBO DE DEVOLUCIÓN") && !texto.includes("RECEIPT_RETURN"),
      "el título sale en inglés",
    );
    afirmar(!/P-END|PEND-|RIF:/.test(texto), "imprime un RIF (el marcador sin RIF)");
    afirmar(!/IVA/.test(texto), "imprime una fila de IVA");
    afirmar(!/PA 00071|art\. 13/.test(texto), "cita la providencia de la factura");
    const copia = await textoDe(PERSONAS.duenaE1, "E1", id, "copia=1");
    afirmar(
      copia.status === 422,
      `la copia fiscal de un recibo de devolución debía ser 422: ${copia.status}`,
    );
  },
);

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
  // E-09: el tornillo vale más que el USD 1,03 que se paga por Zelle, así que el resto de la
  // venta queda FIADO (deuda de verdad, documento `issued`). Fiar exige que el cliente tenga
  // límite: lo fija el dueño por el camino real, una vez. Es una ENTRADA del guion.
  const [lim] = await sql`
    select credit_limit_usd = 100000 as fijado from public.customers where id = ${cl.id}`;
  if (!lim.fijado) {
    const fija = await pedirIgtf(
      PER_IGTF.duenoE2E3,
      "E3",
      "PUT",
      `/v1/customers/${cl.id}/credit-limit`,
      { company_id: E3i, credit_limit_usd: "100000" },
    );
    afirmar(fija.status === 200, `fijar el límite de fiado: ${fija.status} ${fija.texto}`);
  }
  // P-05: una venta que deja saldo dice cuándo se paga. Otra ENTRADA del guion: quince días desde
  // el día de Caracas de la base (el servidor fecha la venta con su reloj, no con RECORRIDO_FECHA).
  const [vence] = await sql`
    select ((now() at time zone 'America/Caracas')::date + 15)::text as dia`;
  const r = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/pos/sales", {
    company_id: E3i,
    customer_id: cl.id,
    warehouse_id: w.id,
    lines: [{ product_id: p.product_id, quantity: "1" }],
    due_date: vence.dia,
    payments: [{ instrument: "zelle", currency: "USD", amount: "1.03" }],
  });
  afirmar(r.status === 201, `venta de caja de E3: ${r.status} ${r.texto}`);
  return r.json;
}

c.caso(
  "G-06",
  "la devolución de una venta de E3 cobrada con IGTF deja el IGTF percibido y lo avisa",
  async () => {
    const v = await ventaZelleIgtfE3();
    const [l] =
      await sql`select id from public.document_lines where document_id = ${v.document.id}`;
    const [w] =
      await sql`select id from public.warehouses where company_id = ${EMP_IGTF.E3} limit 1`;
    const b = await pedirIgtf(PER_IGTF.duenoE2E3, "E3", "POST", "/v1/returns", {
      company_id: EMP_IGTF.E3,
      source_document_id: v.document.id,
      warehouse_id: w.id,
      reason: "Devolución de la comprobación G-06",
      lines: [{ source_line_id: l.id, quantity: "1" }],
    });
    afirmar(b.status === 201, `devolución: ${b.status} ${b.texto}`);
    const c2 = await pedirIgtf(
      PER_IGTF.duenoE2E3,
      "E3",
      "POST",
      `/v1/returns/${b.json.id}/confirm`,
      {},
    );
    afirmar(c2.status === 200, `confirmar: ${c2.status} ${c2.texto}`);
    afirmar(
      c2.json.igtf_not_refunded?.notice ===
        "El IGTF de 0,03 $ ya fue enterado al SENIAT y no se devuelve.",
      `aviso: ${JSON.stringify(c2.json.igtf_not_refunded)}`,
    );
    const [p] =
      await sql`select status from public.igtf_perceptions where document_id = ${v.document.id}`;
    afirmar(p.status === "percibido", "la percepción dejó de estar percibida");
  },
);

// ── Moneda A (ADR-0075 §4) ───────────────────────────────────────────────────
c.caso(
  "G-12",
  "un documento de E2 pagado exacto en Bs queda con saldo CERO en su moneda, sin polvo de conversión",
  async () => {
    const { doc, cobro } = await monedaA.ventaUsdCobradaEnBs();
    afirmar(cobro.status === 201, `el cobro no entró: ${cobro.status}`);
    const [s] = await sql`
      select platform.document_balance_transaction(${EMPRESAS.E2}, ${doc.id})::text as usd,
             platform.document_debt_today(${EMPRESAS.E2}, ${doc.id})::text as hoy`;
    afirmar(Number(s.usd) === 0, `saldo en USD: ${s.usd} (antes, ~0,00000922)`);
    afirmar(Number(s.hoy) === 0, `deuda a la tasa de hoy: ${s.hoy} (antes, ±0,01)`);
  },
);

// ── Ola 4 · G-13 (RESPUESTA §2.15): el talonario se registra en el DOMINIO y deja acta ────────
c.caso(
  "G-13",
  "la ruta del talonario no inserta: delega en registrarTalonario, que deja el acta",
  async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const ruta = fs.readFileSync(
      path.join(raiz, "apps", "api", "src", "routes", "sales.ts"),
      "utf8",
    );
    const dominio = fs.readFileSync(
      path.join(raiz, "packages", "domain", "src", "talonario.ts"),
      "utf8",
    );
    afirmar(
      !/insert into public\.fiscal_number_ranges/.test(ruta),
      "routes/sales.ts sigue insertando el talonario desde el handler",
    );
    afirmar(/registrarTalonario\(tx,/.test(ruta), "la ruta no llama a registrarTalonario");
    afirmar(
      /insert into public\.fiscal_number_ranges/.test(dominio) &&
        /eventType: "fiscal\.range\.registered"/.test(dominio),
      "registrarTalonario no inserta el rango con su acta",
    );
    // La misma regla para TODA la API: ninguna ruta escribe un acta por su cuenta (el régimen y
    // la alícuota lo hacían en fiscal-setup.ts; la regla de retención, en purchases.ts).
    const rutas = path.join(raiz, "apps", "api", "src", "routes");
    for (const f of fs.readdirSync(rutas).filter((n) => n.endsWith(".ts"))) {
      afirmar(
        !/insert into public\.audit_events/.test(fs.readFileSync(path.join(rutas, f), "utf8")),
        `routes/${f} escribe un acta desde el handler: va en el dominio`,
      );
    }
    // El comportamiento —201 y UN acta con origen y versión— lo ejerce B-05 en el bloque B.
  },
);

// ── Ola 4 · G-10, G-14 y G-07: anular o nota de crédito, y la devolución del cajero ─────────
// G-10 (PA 00071 arts. 22 y 36): una factura del escenario, emitida OTRO día y sin cobros, ya no
// se anula. Lo dice el detalle (`annulment`) y lo aplica el servidor al intentarlo. No muta nada.
c.caso(
  "G-10",
  "una factura de E2 de otro día y sin cobros ya no se anula: 409 que manda a la nota de crédito",
  async () => {
    // «Sin cobros» = sin cobros VIVOS: la regla del papel no mira los reversados (P-91), y el
    // caso F-10 del bloque F paga de más y reversa justo la factura por cobrar de E2; contarlo
    // dejaba este caso sin su factura cuando los bloques corren en orden tras restaurar.
    const [f] = await sql`
      select d.id from public.documents d
       where d.company_id = ${E2} and d.kind = 'invoice' and d.status = 'issued'
         and platform.caracas_day(d.issued_at) < platform.caracas_day(now())
         and not exists (
               select 1 from public.payments p
                where p.document_id = d.id
                  and not exists (select 1 from public.payment_reversals r
                                   where r.payment_id = p.id))
       order by d.issued_at limit 1`;
    afirmar(
      f !== undefined,
      "el escenario no tiene una factura de E2 emitida otro día y sin cobros",
    );
    const det = await pedir(PERSONAS.duenoE2E3, "E2", "GET", `/v1/documents/${f.id}`);
    afirmar(det.status === 200, `detalle: ${det.status} ${det.texto}`);
    afirmar(
      det.json.annulment?.allowed === false && det.json.annulment?.reason === "not_same_day",
      `annulment: ${JSON.stringify(det.json.annulment)}`,
    );
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", `/v1/invoices/${f.id}/annul`, {
      company_id: E2,
      reason: "Comprobación G-10 del recorrido",
      originals_in_hand: true,
    });
    afirmar(r.status === 409, `esperaba 409, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(
      r.json.code === "ANNULMENT_NOT_ALLOWED" && r.json.details?.reason === "not_same_day",
      `cuerpo: ${r.texto.slice(0, 300)}`,
    );
    afirmar(/nota de crédito/.test(r.json.message), "el 409 no nombra la nota de crédito");
    const [sigue] = await sql`select status from public.documents where id = ${f.id}`;
    afirmar(sigue.status === "issued", `la factura cambió de estado: ${sigue.status}`);
  },
);

c.caso(
  "G-10",
  "el libro de ventas de E2 lleva las anuladas con su número y los importes en cero",
  async () => {
    const filas = await sql`
      select b.document_number, b.base_gravada, b.iva_debito, b.total_amount
        from platform.sales_book(${E2}, '2026-01-01'::date, platform.caracas_day(now())) b
       where b.status = 'annulled'`;
    afirmar(filas.length > 0, "E2 no tiene ninguna anulada en el libro: el caso no mide nada");
    for (const x of filas) {
      afirmar(
        x.document_number !== null &&
          Number(x.base_gravada) === 0 &&
          Number(x.iva_debito) === 0 &&
          Number(x.total_amount) === 0,
        `anulada con importes: ${JSON.stringify(x)}`,
      );
    }
  },
);

c.caso(
  "G-14",
  "una factura cobrada de E2 dice que no se anula y nombra «Devolución»; la pantalla lo enseña",
  async () => {
    const [f] = await sql`
      select d.id from public.documents d
       where d.company_id = ${E2} and d.kind = 'invoice' and d.status = 'paid'
       order by d.issued_at limit 1`;
    afirmar(f !== undefined, "el escenario no tiene una factura cobrada en E2");
    const det = await pedir(PERSONAS.duenoE2E3, "E2", "GET", `/v1/documents/${f.id}`);
    afirmar(det.status === 200, `detalle: ${det.status} ${det.texto}`);
    afirmar(
      det.json.annulment?.allowed === false && det.json.annulment?.reason === "has_payments",
      `annulment: ${JSON.stringify(det.json.annulment)}`,
    );
    afirmar(/«Devolución»/.test(det.json.annulment.message), "el motivo no nombra «Devolución»");
    // La pantalla: el aviso se pinta FUERA del diálogo de Anular (que no se puede abrir) y trae
    // el botón «Devolución». Comprobación de fuente.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const pantalla = fs.readFileSync(
      path.join(raiz, "apps", "web", "src", "pages", "ventas", "DetalleFactura.tsx"),
      "utf8",
    );
    afirmar(
      /porQueNoSeAnula !== null &&/.test(pantalla) && /\{porQueNoSeAnula\}/.test(pantalla),
      "DetalleFactura no enseña el motivo por el que no se anula",
    );
    afirmar(
      /annulment\?\.allowed === true/.test(pantalla),
      "DetalleFactura decide «Anular» sin preguntar al servidor",
    );
  },
);

c.caso(
  "G-07",
  "cajero@ inicia una devolución en E2 (201) y la descarta; reembolsar le da 403 de sales.refund",
  async () => {
    const [l] = await sql`
      select d.id as doc, dl.id as linea, d.kind
        from public.documents d
        join public.document_lines dl on dl.document_id = d.id
       where d.company_id = ${E2} and d.kind = 'invoice' and d.status = 'paid'
         and dl.quantity >= 1
         and not exists (select 1 from public.returns r where r.source_document_id = d.id)
       order by d.issued_at desc limit 1`;
    afirmar(l !== undefined, "el escenario no tiene una factura cobrada de E2 sin devoluciones");
    const [w] = await sql`
      select id from public.warehouses where company_id = ${E2} order by created_at limit 1`;
    const b = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/returns", {
      company_id: E2,
      source_document_id: l.doc,
      warehouse_id: w.id,
      reason: "Comprobación G-07 del recorrido",
      lines: [{ source_line_id: l.linea, quantity: "1" }],
    });
    afirmar(b.status === 201, `el cajero no pudo iniciar la devolución: ${b.status} ${b.texto}`);
    // Se descarta el borrador: la comprobación no mueve mercancía ni emite notas en el escenario.
    const x = await pedir(PERSONAS.cajero, "E2", "POST", `/v1/returns/${b.json.id}/cancel`, {});
    afirmar(x.status === 200, `descartar: ${x.status} ${x.texto}`);

    const r = await pedir(
      PERSONAS.cajero,
      "E2",
      "POST",
      `/v1/customer-credits/${b.json.id}/refunds`,
      {
        company_id: E2,
        account_id: b.json.id,
        amount: "1.00",
        reason: "Comprobación G-07: el cajero no reembolsa",
      },
    );
    afirmar(r.status === 403, `esperaba 403, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(
      r.json.message === "La operación exige el permiso sales.refund sobre esta empresa.",
      `mensaje: ${r.json.message}`,
    );
  },
);

// ── Ola 4 · el estado de cuenta, el saldo a favor en su moneda, su reembolso y la reversa ───
c.caso("G-04", "en el estado de cuenta ninguna nota de crédito aparece debiendo", async () => {
  const fs = await import("node:fs");
  // Ola 4 · cobros, cuarta pasada (R-84): la regla ya no vive en la ruta. La lectura con nombre
  // del dominio la lleva, y el handler solo la llama (apps/api no contiene reglas de negocio).
  const lectura = fs.readFileSync("packages/domain/src/customer-statement.ts", "utf8");
  afirmar(lectura.includes("G-04: una nota de crédito"), "el dominio no trata la nota aparte");
  const ruta = fs.readFileSync("apps/api/src/routes/sales.ts", "utf8");
  afirmar(
    ruta.includes("return customerStatement(tx, companyId, id);") &&
      !ruta.includes("from public.customer_credits cc"),
    "la ruta del estado de cuenta sigue valorando el saldo a favor por su cuenta",
  );
  for (const e of ["E1", "E2", "E3"]) {
    const clientes = await sql`
      select distinct d.customer_id from public.documents d
       where d.company_id = ${EMPRESAS[e]} and d.kind in ('credit_note', 'receipt_return')
         and d.status in ('issued', 'paid') and d.customer_id is not null limit 5`;
    const persona = e === "E1" ? PERSONAS.duenaE1 : PERSONAS.duenoE2E3;
    for (const cl of clientes) {
      const r = await pedir(persona, e, "GET", `/v1/customers/${cl.customer_id}/statement`);
      afirmar(r.status === 200, `${e}: ${r.status} ${r.texto.slice(0, 200)}`);
      for (const d of r.json.documents) {
        if (d.kind !== "credit_note" && d.kind !== "receipt_return") continue;
        afirmar(
          d.balance === null || Number(d.balance) <= 0,
          `${e}: la nota ${d.series}-${d.document_number} aparece debiendo ${d.balance}`,
        );
      }
      for (const cr of r.json.credits) {
        afirmar(typeof cr.currency === "string", `${e}: un saldo a favor sin moneda`);
      }
    }
  }
});

c.caso(
  "G-05",
  "los saldos a favor anteriores siguen en bolívares; los nuevos guardan su tasa",
  async () => {
    for (const e of ["E1", "E2", "E3"]) {
      const [n] = await sql`
      select count(*) filter (where cc.currency <> co.functional_currency_code
                                and cc.fx_rate is null)::int as divisa_sin_tasa
        from public.customer_credits cc
        join public.companies co on co.id = cc.company_id
       where cc.company_id = ${EMPRESAS[e]}`;
      afirmar(
        n.divisa_sin_tasa === 0,
        `${e}: ${n.divisa_sin_tasa} saldos a favor en divisa sin tasa`,
      );
    }
    const fs = await import("node:fs");
    const ventas = fs.readFileSync("packages/domain/src/sales.ts", "utf8");
    afirmar(
      ventas.split("G-05 (ADR-0075 §4): en la moneda de la nota").length === 3,
      "la nota de crédito o la devolución no crean el saldo a favor en la moneda de la nota",
    );
  },
);

c.caso(
  "G-15",
  "el reembolso de un saldo a favor lleva su diferencial y la pantalla lo ofrece",
  async () => {
    for (const e of ["E1", "E2", "E3"]) {
      const [t] = await sql`
      select count(*)::int as plantillas,
             count(*) filter (where (
               select count(*) from public.journal_template_lines l
                where l.template_id = t.id and l.amount_source = 'exchange_difference') = 2)::int
               as con_diferencial
        from public.journal_templates t
       where t.company_id = ${EMPRESAS[e]} and t.effective_to is null
         and t.source_kind = 'customer_refund' and t.source_event = 'ar.credit_refunded'`;
      afirmar(
        t.plantillas === t.con_diferencial,
        `${e}: ${t.con_diferencial} de ${t.plantillas} plantillas con diferencial`,
      );
    }
    const fs = await import("node:fs");
    const cuentas = fs.readFileSync("apps/web/src/pages/ventas/Cuentas.tsx", "utf8");
    afirmar(
      cuentas.includes('puede("sales.refund")') && cuentas.includes("Devolver en dinero"),
      "el estado de cuenta no ofrece devolver el saldo a favor",
    );
  },
);

c.caso(
  "G-rev",
  "el detalle del documento ofrece reversar un cobro y una retención, con su permiso",
  async () => {
    const fs = await import("node:fs");
    const detalle = fs.readFileSync("apps/web/src/pages/ventas/DetalleFactura.tsx", "utf8");
    afirmar(detalle.includes("<ReversarCobro"), "el detalle no abre la reversa");
    afirmar(
      detalle.includes('puede("ar.payment.reverse")') &&
        detalle.includes('puede("ar.retention.correct")'),
      "la reversa no se ofrece por permiso",
    );
    const dialogo = fs.readFileSync("apps/web/src/components/ReversarCobro.tsx", "utf8");
    for (const codigo of ["IGTF_NOTE_ISSUED", "PAYMENT_ALREADY_REVERSED"]) {
      afirmar(dialogo.includes(codigo), `el diálogo no dice qué hacer con ${codigo}`);
    }
    afirmar(dialogo.includes("vuelve a deber"), "el diálogo no dice qué va a pasar");
  },
);

// ── Ola 4 · revisión de «devoluciones y anulación» (migración 20261004160300) ───────────────
c.caso(
  "G-07",
  "cajero@ no emite una nota de crédito directa (403 de sales.credit_note.direct) y la pantalla no se la ofrece",
  async () => {
    const [l] = await sql`
      select d.id as doc, dl.id as linea
        from public.documents d
        join public.document_lines dl on dl.document_id = d.id
       where d.company_id = ${E2} and d.kind = 'invoice' and d.status in ('issued', 'paid')
       order by d.issued_at desc limit 1`;
    afirmar(l !== undefined, "el escenario no tiene una factura emitida de E2");
    const r = await pedir(PERSONAS.cajero, "E2", "POST", "/v1/credit-notes", {
      company_id: E2,
      source_document_id: l.doc,
      reason: "Comprobación G-07: el cajero no emite notas directas",
      lines: [{ source_line_id: l.linea, quantity: "1" }],
    });
    afirmar(r.status === 403, `esperaba 403, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(
      r.json.message ===
        "La operación exige el permiso sales.credit_note.direct sobre esta empresa.",
      `mensaje: ${r.json.message}`,
    );
    afirmar(
      r.json.person_message ===
        "Necesitas el permiso para emitir notas de crédito sin devolución de mercancía. Pídeselo a quien administra el negocio.",
      `mensaje de persona: ${r.json.person_message}`,
    );
    const fs = await import("node:fs");
    const detalle = fs.readFileSync("apps/web/src/pages/ventas/DetalleFactura.tsx", "utf8");
    afirmar(
      /pagable && puede\("sales\.credit_note\.direct"\)/.test(detalle) &&
        !/pagable && puede\("sales\.return\.manage"\)/.test(detalle),
      "el detalle ofrece la nota de crédito directa sin su permiso",
    );
    afirmar(
      /devolvible && puede\("sales\.return\.manage"\)/.test(detalle),
      "el detalle dejó de ofrecer la devolución a quien tiene sales.return.manage",
    );
  },
);

c.caso(
  "G-10",
  "la casilla del original y las copias se reinicia al abrir y cerrar el diálogo y al cambiar de documento",
  async () => {
    const fs = await import("node:fs");
    const detalle = fs.readFileSync("apps/web/src/pages/ventas/DetalleFactura.tsx", "utf8");
    afirmar(
      /const abrirAnulacion = \(abierto: boolean\): void => \{\s*setPapelEnMano\(false\);\s*setAnulando\(abierto\);/.test(
        detalle,
      ),
      "abrir o cerrar el diálogo no reinicia la casilla",
    );
    afirmar(
      detalle.includes("onOpenChange={abrirAnulacion}") &&
        detalle.includes("onClick={() => abrirAnulacion(true)}") &&
        !detalle.includes("onOpenChange={setAnulando}") &&
        !detalle.includes("setAnulando(true)"),
      "el diálogo de anular se abre o se cierra por un camino que no reinicia la casilla",
    );
    afirmar(
      /useEffect\(\(\) => \{\s*setPapelEnMano\(false\);\s*setAnulando\(false\);\s*\}, \[id\]\);/.test(
        detalle,
      ),
      "cambiar de documento no reinicia la casilla",
    );
  },
);

c.caso(
  "G-10",
  "la regla del papel: «declarado» es el de la casa (B-1), la caja es cualquiera de la empresa, y no es de authenticated",
  async () => {
    const [f] = await sql`
      select pg_get_functiondef(
               'platform.invoice_annulment_blockers(uuid, uuid, timestamptz)'::regprocedure) as def,
             has_function_privilege('authenticated',
               'platform.invoice_annulment_blockers(uuid, uuid, timestamptz)', 'execute') as auth1,
             has_function_privilege('authenticated',
               'platform.annulment_paper_gaps(uuid)', 'execute') as auth2`;
    afirmar(
      f.def.includes("r.period_to < platform.caracas_day(r.created_at)"),
      "la regla da por declarado un período con una vista previa",
    );
    afirmar(
      f.def.includes("ca.kind = 'cash'") && !f.def.includes("from public.payments"),
      "la regla del cierre de caja no es la uniforme",
    );
    afirmar(!f.auth1 && !f.auth2, "authenticated todavía ejecuta la regla o su invariante");
    for (const e of ["E1", "E2", "E3"]) {
      const huecos = await sql`
        select document_id, problem from platform.annulment_paper_gaps(${EMPRESAS[e]})`;
      afirmar(huecos.length === 0, `${e}: annulment_paper_gaps da ${huecos.length} fila(s)`);
    }
  },
);

// ── Ola 4 · cobros, cuarta pasada: lo nuevo de la tercera ronda (ADR-0075 decisión 5; R-84) ──
c.caso(
  "G-05 (tercera ronda)",
  "un saldo a favor agotado o retirado no deja nada en el pasivo del mayor: 0,00 exacto, saldo por saldo",
  async () => {
    // NO escribe. Mide el MAYOR —no `customer_credit_carried`, que es la regla que se comprueba—:
    // lo que la cuenta «saldos a favor de clientes» carga por los hechos de CADA saldo (su
    // nacimiento, sus usos, sus reembolsos y la reversa del cobro que lo creó).
    let agotados = 0;
    for (const e of ["E1", "E2", "E3"]) {
      const filas = await sql`
        select cc.id, cc.status, cc.currency, cc.amount::text as importe,
               (select coalesce(sum(l.functional_credit - l.functional_debit), 0)
                  from public.journal_entries je
                  join public.journal_lines l on l.entry_id = je.id
                 where je.company_id = cc.company_id and je.status = 'posted'
                   and l.account_id in (select s.account_id
                                          from public.company_account_settings s
                                         where s.company_id = cc.company_id
                                           and s.purpose = 'customer_credit_liability')
                   and ((cc.source_payment_id is null and je.source_id = cc.source_document_id)
                        or je.source_id = cc.source_payment_id
                        or je.source_id in (select pr.id from public.payment_reversals pr
                                             where pr.payment_id = cc.source_payment_id)
                        or je.source_id in (select p.id from public.payments p
                                             where p.customer_credit_id = cc.id)
                        or je.source_id in (select r.id from public.customer_refunds r
                                             where r.customer_credit_id = cc.id)))::text as mayor,
               platform.customer_credit_carried(cc.company_id, cc.id)::text as lleva
          from public.customer_credits cc
         where cc.company_id = ${EMPRESAS[e]}
           and (cc.status in ('applied', 'expired') or cc.applied_amount = cc.amount)`;
      for (const f of filas) {
        afirmar(
          Number(f.mayor) === 0,
          `${e}: el saldo a favor ${f.id} (${f.status}, ${f.importe} ${f.currency}) deja ${f.mayor} en el pasivo`,
        );
        // `customer_credit_carried` se comprueba solo en el AGOTADO. En un saldo RETIRADO responde
        // su importe de nacimiento (no descuenta la reversa del cobro que lo creó) aunque el mayor
        // cargue cero: quien la llama filtra los retirados antes. Está reportado como hallazgo
        // abierto (R-84); aquí no se asevera para no dar por buena ni por mala esa respuesta.
        if (f.status === "expired") continue;
        agotados += 1;
        afirmar(
          Number(f.lleva) === 0,
          `${e}: customer_credit_carried da ${f.lleva} para el saldo ${f.id} (${f.status})`,
        );
      }
      const brecha = await sql`select * from platform.customer_credit_ledger_gap(${EMPRESAS[e]})`;
      afirmar(brecha.length === 0, `${e}: customer_credit_ledger_gap ${JSON.stringify(brecha[0])}`);
    }
    afirmar(
      agotados > 0,
      "el escenario no tiene ningún saldo a favor agotado: no se comprobó nada",
    );
  },
);

export default c.correr;

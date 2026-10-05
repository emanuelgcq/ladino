/**
 * Bloque P · Datos. Comprobaciones de `pnpm recorrido P` (ver `_app.mjs`).
 *
 * P-02: el documento se guarda NORMALIZADO en todos los caminos (la reparación
 *   scripts/reparar/p-02-rif-normalizado.mjs corre tras la restauración) y la búsqueda encuentra
 *   con cualquier grafía.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("P");

c.caso("P-02", "buscar «J40999888» y «J-40999888-1» encuentra a Abastos El Sol", async () => {
  for (const grafia of ["J40999888", "J-40999888-1"]) {
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      `/v1/customers?search=${encodeURIComponent(grafia)}`,
    );
    afirmar(r.status === 200, `«${grafia}» dio ${r.status}`);
    const nombres = r.json.items.map((x) => x.legal_name);
    afirmar(nombres.includes("Abastos El Sol, C.A."), `«${grafia}» → ${JSON.stringify(nombres)}`);
  }
});

c.caso(
  "P-02",
  "ningún cliente, proveedor ni empresa de E1-E3 guarda el documento con separadores",
  async () => {
    const ids = Object.values(EMPRESAS);
    const [f] = await sql`
    select (select count(*) from public.customers where company_id = any(${ids}::uuid[])
              and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
         + (select count(*) from public.suppliers where company_id = any(${ids}::uuid[])
              and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
         + (select count(*) from public.companies where id = any(${ids}::uuid[])
              and upper(tax_id) not like 'PEND-%'
              and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'))) as n`;
    afirmar(Number(f.n) === 0, `${f.n} documento(s) sin normalizar`);
  },
);

// P-04 (ola 3): la deuda de cada cliente se lee con ar.read. El cajero la recibe; el almacenista no.
c.caso(
  "P-04",
  "el almacenista pide /v1/customers?with_debt=1 en E2 → 403 en palabras de persona",
  async () => {
    const r = await pedir(PERSONAS.almacenista, "E2", "GET", "/v1/customers?with_debt=1");
    afirmar(r.status === 403, `esperaba 403, llegó ${r.status}`);
    afirmar(
      r.json?.person_message?.includes("ver lo que deben los clientes"),
      `person_message: ${r.json?.person_message}`,
    );
  },
);
c.caso("P-04", "el cajero pide /v1/customers?with_debt=1 en E2 → 200 con la deuda", async () => {
  const r = await pedir(PERSONAS.cajero, "E2", "GET", "/v1/customers?with_debt=1");
  // La deuda se valora a la tasa de HOY (ADR-0047). La siembra corregir-escenario-post.sql; si
  // falta, el escenario está mal, no el permiso: se dice así y falla.
  afirmar(
    !(r.status === 409 && r.json?.code === "EXCHANGE_RATE_MISSING"),
    `escenario sin tasa del día (corregir-escenario-post.sql no la sembró): ${r.json?.message}`,
  );
  afirmar(r.status === 200, `esperaba 200, llegó ${r.status}: ${r.texto.slice(0, 160)}`);
  afirmar(
    r.json.items.length > 0 && r.json.items.every((i) => typeof i.debt === "string"),
    "la lista del cajero no trae la deuda",
  );
});

c.caso(
  "P-10",
  "«por agotarse» cuenta la existencia de TODOS los lotes y solo productos activos (ADR-0078)",
  async () => {
    const [f] = await sql`
      select count(*)::int as n
        from unnest(${Object.values(EMPRESAS)}::uuid[]) as e(id),
             lateral platform.low_stock_products(e.id) l
        join public.products p on p.id = l.product_id
       where p.status <> 'active'
          or l.quantity <> coalesce((select sum(b.quantity) from public.stock_balances b
                                      where b.warehouse_id = l.warehouse_id
                                        and b.product_id = l.product_id), 0)`;
    afirmar(f.n === 0, `${f.n} fila(s) de «por agotarse» sin los lotes o con un inactivo`);
  },
);

// P-01 (ola 3, ADR-0075 §7): «Lo que gané» al céntimo en las tres empresas.
c.caso("P-01", "«Lo que gané» de E1, E2 y E3 llega con dos decimales exactos", async () => {
  for (const [e, persona] of [
    ["E1", PERSONAS.duenaE1],
    ["E2", PERSONAS.duenoE2E3],
    ["E3", PERSONAS.duenoE2E3],
  ]) {
    const r = await pedir(persona, e, "GET", "/v1/negocio/resumen");
    afirmar(r.status === 200, `${e}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
    for (const k of ["ganado_hoy", "ganado_mes"]) {
      afirmar(/^-?\d+\.\d{2}$/.test(r.json[k]), `${e} ${k} = ${r.json[k]}`);
    }
  }
});

// P-03 (ola 3): tras la regularización al corte, ninguna línea, movimiento ni saldo con fracción.
c.caso(
  "P-03",
  "cent_gaps da cero en E1, E2 y E3 (gastos y pagos en divisa incluidos)",
  async () => {
    const [f] = await sql`
    select count(*)::int as n
      from unnest(${Object.values(EMPRESAS)}::uuid[]) as e(id),
           lateral platform.cent_gaps(e.id) g`;
    afirmar(f.n === 0, `${f.n} importe(s) con fracción de céntimo`);
  },
);
c.caso(
  "P-03",
  "el saldo de la cuenta 1.1.02 (y sus subcuentas) de E2 está al céntimo",
  async () => {
    const [f] = await sql`
    select count(*)::int as n
      from (select jl.account_id, sum(jl.functional_debit - jl.functional_credit) as s
              from public.journal_lines jl
              join public.journal_entries en on en.id = jl.entry_id
              join public.accounts a on a.id = jl.account_id
             where jl.company_id = ${EMPRESAS.E2} and a.code like '1.1.02%'
               and en.status in ('posted', 'reversed')
             group by jl.account_id) x
     where x.s <> round(x.s, 2)`;
    afirmar(f.n === 0, `${f.n} cuenta(s) de 1.1.02 con saldo fraccionario`);
  },
);

// P-03 (revisión de la ola 3): la política guardada en el kardex es la que produjo el importe, y
// ninguna posición vacía esconde valor en «Diferencias por redondeo».
c.caso(
  "P-03",
  "ningún asiento posteado después del corte lleva una línea con más de dos decimales (LAD71)",
  async () => {
    const [f] = await sql`
      select count(*)::int as n
        from unnest(${Object.values(EMPRESAS)}::uuid[]) as e(id),
             lateral platform.cent_gaps(e.id) g
       where g.kind in ('journal_line', 'account_balance')`;
    afirmar(f.n === 0, `${f.n} línea(s) o saldo(s) del mayor con fracción de céntimo`);
  },
);
c.caso(
  "P-03",
  "la regularización no mandó a redondeo más que polvo: ninguna revalorización suya pasa de 0,005 × movimientos",
  async () => {
    const [f] = await sql`
      select count(*)::int as n
        from public.inventory_moves m
        join public.stock_balances b
          on b.company_id = m.company_id and b.warehouse_id = m.warehouse_id
         and b.product_id = m.product_id and b.lot_id is not distinct from m.lot_id
       where m.company_id = any(${Object.values(EMPRESAS)}::uuid[])
         and m.kind = 'revaluacion'
         and m.reason = 'Regularización del céntimo al corte (ADR-0075 §7)'
         and abs(m.functional_amount) > 0.005 * b.moves_count`;
    afirmar(f.n === 0, `${f.n} revalorización(es) de la regularización por encima del polvo`);
  },
);

// P-04 / N-07 (re-revisión): el resumen se sirve con treasury.read, pero cada total de deuda va
// en null sin el permiso de su libro (ar.read / ap.read). Nunca «0.00» por falta de acceso.
c.caso(
  "P-04",
  "el resumen de E2 da cada total de deuda solo a quien tiene ar.read / ap.read",
  async () => {
    let vistos = 0;
    for (const [nombre, correo] of Object.entries(PERSONAS)) {
      const r = await pedir(correo, "E2", "GET", "/v1/negocio/resumen");
      if (r.status !== 200) continue;
      vistos += 1;
      const [p] = await sql`
        select platform.ladino_user_has_permission(u.id, 'ar.read', ${EMPRESAS.E2}) as ar,
               platform.ladino_user_has_permission(u.id, 'ap.read', ${EMPRESAS.E2}) as ap
          from auth.users u where u.email = ${correo}`;
      afirmar(p !== undefined, `${nombre}: sin usuario en auth.users`);
      for (const [campo, tiene] of [
        ["lo_que_me_deben", p.ar],
        ["lo_que_debo", p.ap],
      ]) {
        const v = r.json[campo];
        afirmar(
          tiene ? typeof v === "string" && /^\d+\.\d{2}$/.test(v) : v === null,
          `${nombre}: ${campo} = ${JSON.stringify(v)} con permiso = ${tiene}`,
        );
      }
    }
    afirmar(vistos > 0, "sin datos: nadie de E2 pudo abrir el resumen");
  },
);

// Ola 4 (familia de N-05: «no hay» contra «no puedes ver»): el `null` de un total de deuda dice
// su motivo en un campo aparte. Sin permiso: `sin_permiso`. Con cifra: motivo `null`.
c.caso(
  "P-04 (motivo)",
  "cada total de deuda en null dice por qué: sin_permiso para quien no tiene el permiso de su libro",
  async () => {
    let vistos = 0;
    for (const [nombre, correo] of Object.entries(PERSONAS)) {
      const r = await pedir(correo, "E2", "GET", "/v1/negocio/resumen");
      if (r.status !== 200) continue;
      vistos += 1;
      const [p] = await sql`
        select platform.ladino_user_has_permission(u.id, 'ar.read', ${EMPRESAS.E2}) as ar,
               platform.ladino_user_has_permission(u.id, 'ap.read', ${EMPRESAS.E2}) as ap
          from auth.users u where u.email = ${correo}`;
      for (const [campo, tiene] of [
        ["lo_que_me_deben", p.ar],
        ["lo_que_debo", p.ap],
      ]) {
        const v = r.json[campo];
        const motivo = r.json[`${campo}_motivo`];
        const porMoneda = r.json[`${campo}_por_moneda`];
        afirmar(Array.isArray(porMoneda), `${nombre}: ${campo}_por_moneda no es una lista`);
        if (!tiene) {
          afirmar(
            v === null && motivo === "sin_permiso" && porMoneda.length === 0,
            `${nombre}: ${campo} sin permiso → ${JSON.stringify({ v, motivo, porMoneda })}`,
          );
        } else {
          // Con permiso: o la cifra (motivo null), o falta la tasa y va el nominal por moneda.
          afirmar(
            (typeof v === "string" && motivo === null) || (v === null && motivo === "sin_tasa"),
            `${nombre}: ${campo} con permiso → ${JSON.stringify({ v, motivo })}`,
          );
        }
      }
    }
    afirmar(vistos > 0, "sin datos: nadie de E2 pudo abrir el resumen");
  },
);

// P-05 (ola 4): «Te deben…» lleva a la lista ORDENADA por deuda, mayor primero, y se puede
// ordenar. La deuda es la de la única función (`platform.customer_debt_today`) y exige `ar.read`.
c.caso(
  "P-05",
  "la lista de clientes de E2 se ordena por deuda, mayor primero y al revés; el recordatorio lleva ahí",
  async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const lista = (orden) =>
      pedir(
        PERSONAS.duenoE2E3,
        "E2",
        "GET",
        `/v1/customers?with_debt=1&per_page=100&sort=${orden}`,
      );
    const desc = await lista("debt_desc");
    afirmar(desc.status === 200, `sort=debt_desc dio ${desc.status}: ${desc.texto.slice(0, 160)}`);
    const deudas = desc.json.items.map((i) => i.debt);
    afirmar(deudas.length >= 2, `E2 solo tiene ${deudas.length} cliente(s)`);
    // Comparación en la base (numeric), no en JS: ¿está la lista en orden no creciente?
    const [ord] = await sql`
      with f as (select d, o from unnest(${deudas.filter((d) => d !== null)}::numeric[])
                   with ordinality as t(d, o))
      select coalesce(bool_and(d <= ant), true) as ok, max(d)::text as mayor
        from (select d, lag(d) over (order by o) as ant from f) x where ant is not null`;
    afirmar(ord.ok === true, `la lista no va de mayor a menor: ${deudas.join(", ")}`);
    // El primero con cifra es el que más debe según LA función de deuda.
    const [maximo] = await sql`
      select round(max(platform.customer_debt_today(cu.company_id, cu.id)), 2)::text as m
        from public.customers cu where cu.company_id = ${EMPRESAS.E2}`;
    const primera = deudas.find((d) => d !== null);
    afirmar(primera === maximo.m, `encabeza ${primera}; la mayor deuda de E2 es ${maximo.m}`);
    afirmar(primera !== "0.00", "sin datos: nadie debe en E2, el orden no se demuestra");
    // Lo que no se pudo valorar (null) va ARRIBA: debe, y no se sabe cuánto.
    const primerNoNulo = deudas.findIndex((d) => d !== null);
    afirmar(
      deudas.slice(primerNoNulo).every((d) => d !== null),
      "un cliente sin valorar quedó debajo de uno valorado",
    );
    const asc = await lista("debt_asc");
    afirmar(asc.status === 200, `sort=debt_asc dio ${asc.status}`);
    const alReves = asc.json.items.map((i) => i.debt).filter((d) => d !== null);
    afirmar(alReves[alReves.length - 1] === maximo.m, "debt_asc no termina en la mayor deuda");
    // Ruidoso antes que silencioso: un orden desconocido, o por deuda sin pedir la deuda, es 422.
    const raro = await lista("saldo");
    afirmar(raro.status === 422, `un sort desconocido dio ${raro.status}`);
    const sinDeuda = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/customers?sort=debt_desc");
    afirmar(sinDeuda.status === 422, `sort=debt_desc sin with_debt dio ${sinDeuda.status}`);
    // Y respeta ar.read: el almacenista no ordena por lo que no puede ver.
    const almacen = await pedir(
      PERSONAS.almacenista,
      "E2",
      "GET",
      "/v1/customers?with_debt=1&sort=debt_desc",
    );
    afirmar(almacen.status === 403, `el almacenista ordenó por deuda: ${almacen.status}`);
    // La lista por nombre (la de siempre) no cambió.
    const nombre = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/customers?per_page=100");
    const nombres = nombre.json.items.map((i) => i.legal_name);
    const [mismo] = await sql`
      select array_agg(legal_name order by legal_name, id) as n
        from public.customers where company_id = ${EMPRESAS.E2}`;
    afirmar(
      JSON.stringify(nombres) === JSON.stringify(mismo.n.slice(0, 100)),
      "la lista sin sort dejó de ir por nombre",
    );
    // La pantalla: el recordatorio y «Ver quién me debe» llevan a la lista ya ordenada.
    const leer = (...p) => fs.readFileSync(path.join(raiz, "apps", "web", "src", ...p), "utf8");
    afirmar(
      leer("pages", "negocio", "Inicio.tsx").includes('"/admin/clientes?orden=vencido"'),
      "el recordatorio «Te deben…» no lleva a la lista ordenada por deuda vencida",
    );
    afirmar(
      leer("pages", "clientes", "Clientes.tsx").includes("debt_desc"),
      "la lista de clientes no pide el orden por deuda",
    );
  },
);

// P-05 (ola 4, el vencimiento): la lista se ordena por deuda VENCIDA. Lo vencido es la deuda de
// la única función sobre los documentos cuyo vencimiento —o, sin él, su día de emisión— ya pasó
// (`platform.customer_overdue_today`, migración 20261004210000).
c.caso(
  "P-05",
  "la lista de clientes de E2 se ordena por deuda vencida; lo vencido nunca pasa de lo que se debe; exige ar.read",
  async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const r = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      "/v1/customers?with_debt=1&per_page=100&sort=overdue_desc",
    );
    afirmar(r.status === 200, `sort=overdue_desc dio ${r.status}: ${r.texto.slice(0, 160)}`);
    const filas = r.json.items;
    afirmar(
      filas.every((i) => "overdue" in i && "overdue_reason" in i),
      "la lista con deuda no trae lo vencido",
    );
    // Sin valorar (null con motivo) arriba; después, no creciente. Comparado en la base (numeric).
    afirmar(
      filas.every((i) => (i.overdue === null) === (i.overdue_reason === "sin_tasa")),
      "un vencido nulo sin motivo, o un motivo con cifra",
    );
    const primerValorado = filas.findIndex((i) => i.overdue !== null);
    const valorados = primerValorado < 0 ? [] : filas.slice(primerValorado);
    afirmar(
      valorados.every((i) => i.overdue !== null),
      "un cliente con lo vencido sin valorar quedó debajo de uno valorado",
    );
    const [ord] = await sql`
      with f as (select v, o from unnest(${valorados.map((i) => i.overdue)}::numeric[])
                   with ordinality as t(v, o))
      select coalesce(bool_and(v <= ant), true) as ok
        from (select v, lag(v) over (order by o) as ant from f) x where ant is not null`;
    afirmar(ord.ok, "la lista por vencido no va de mayor a menor");
    // Lo vencido es PARTE de la deuda: nunca la supera (misma función de deuda).
    const [cota] = await sql`
      select coalesce(bool_and(v <= d), true) as ok
        from unnest(${valorados.filter((i) => i.debt !== null).map((i) => i.overdue)}::numeric[],
                    ${valorados.filter((i) => i.debt !== null).map((i) => i.debt)}::numeric[])
             as t(v, d)`;
    afirmar(cota.ok, "a algún cliente se le dice más vencido que deuda");
    // Y la lista cuadra con la función, cliente por cliente (hoy, en Caracas).
    const [dif] = await sql`
      select count(*)::int as n
        from unnest(${valorados.map((i) => i.id)}::uuid[],
                    ${valorados.map((i) => i.overdue)}::numeric[]) as t(id, v)
       where v <> (select round(coalesce(sum(o.functional_today), 0), 2)
                     from platform.customer_overdue_today(${EMPRESAS.E2}, t.id) o)`;
    afirmar(dif.n === 0, `${dif.n} cliente(s) con un vencido distinto del de la función`);

    const almacen = await pedir(
      PERSONAS.almacenista,
      "E2",
      "GET",
      "/v1/customers?with_debt=1&sort=overdue_desc",
    );
    afirmar(almacen.status === 403, `el almacenista ordenó por vencido: ${almacen.status}`);
    const raro = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      "/v1/customers?with_debt=1&sort=vencido",
    );
    afirmar(raro.status === 422, `un sort desconocido dio ${raro.status}`);

    const leer = (...p) => fs.readFileSync(path.join(raiz, "apps", "web", "src", ...p), "utf8");
    afirmar(
      leer("pages", "negocio", "Dinero.tsx").includes('"/admin/clientes?orden=vencido"'),
      "«Ver quién me debe» no lleva a la lista ordenada por deuda vencida",
    );
    const clientes = leer("pages", "clientes", "Clientes.tsx");
    afirmar(
      clientes.includes("overdue_desc") && clientes.includes("Vencido"),
      "la lista de clientes no tiene la columna «Vencido» ni pide su orden",
    );
    afirmar(
      leer("pages", "negocio", "Vender.tsx").includes("¿Cuándo paga?"),
      "la caja no pregunta «¿Cuándo paga?» al fiar",
    );
  },
);

// ── Ola 5 · P-06 (ADR-0081): la paleta encuentra documentos por su número, según el rol ──
c.caso(
  "P-06",
  "buscar «A-2», «LM-5501» y «R-5»: el dueño los encuentra; el cajero no la compra; el almacén, nada",
  async () => {
    const buscar = async (quien, empresa, q) => {
      const r = await pedir(
        quien,
        empresa,
        "GET",
        `/v1/search/documents?q=${encodeURIComponent(q)}`,
      );
      afirmar(r.status === 200, `«${q}» como ${quien} dio ${r.status}: ${r.texto.slice(0, 200)}`);
      afirmar(
        Object.keys(r.json).join() === "items",
        `la respuesta lleva algo más que la lista (¿un total?): ${Object.keys(r.json).join()}`,
      );
      return r.json.items;
    };
    const dueno = PERSONAS.duenoE2E3;

    // Una factura por su número. Lo exacto va primero: en E2 hay DOS «A-2» (la factura y una
    // nota de crédito, cada tipo con su correlativo), y las dos encabezan antes que «A-2x».
    const exacta = await buscar(dueno, "E2", "A-2");
    afirmar(
      exacta.some((i) => i.type === "invoice" && i.number === "A-2"),
      `«A-2» no encuentra la factura A-2: ${JSON.stringify(exacta)}`,
    );
    const primerParcial = exacta.findIndex((i) => i.number !== "A-2");
    afirmar(
      exacta[0]?.number === "A-2" &&
        (primerParcial === -1 || exacta.slice(primerParcial).every((i) => i.number !== "A-2")),
      `lo exacto no va primero: ${exacta.map((i) => i.number).join(", ")}`,
    );
    const conCeros = await buscar(dueno, "E2", "A-00000005");
    afirmar(
      conCeros.some((i) => i.type === "invoice" && i.number === "A-5"),
      "«A-00000005» no encuentra la factura A-5",
    );
    // «a-1», en minúsculas, es también el principio de A-10…A-16: sale más de uno, sin importes.
    const parte = await buscar(dueno, "E2", "a-1");
    afirmar(parte.length > 1, `«a-1» (una parte, en minúsculas) dio ${parte.length}`);
    afirmar(
      parte.every((i) => Object.keys(i).sort().join() === "date,id,number,party_name,status,type"),
      "un resultado lleva campos de más (¿un importe?)",
    );
    // Las notas se encuentran igual que las facturas.
    const notas = await buscar(dueno, "E2", "A-1");
    afirmar(
      notas.some((i) => i.type === "credit_note" && i.number === "A-1") &&
        notas.some((i) => i.type === "debit_note" && i.number === "A-1"),
      `«A-1» no trae las notas A-1: ${notas.map((i) => `${i.type} ${i.number}`).join(", ")}`,
    );
    // El recibo de E1, que el informe buscó y no encontró.
    const recibo = await buscar(PERSONAS.duenaE1, "E1", "R-5");
    afirmar(
      recibo.some((i) => i.type === "receipt" && i.number === "R-5"),
      "«R-5» no encuentra el recibo de E1",
    );

    // La compra, por el número del proveedor: entera y una parte.
    for (const q of ["LM-5501", "5501"]) {
      const compra = await buscar(dueno, "E2", q);
      afirmar(
        compra.some((i) => i.type === "purchase" && i.number === "LM-5501"),
        `«${q}» no encuentra la compra LM-5501`,
      );
    }

    // El cajero encuentra la venta y NO la compra; el almacenista, ninguna de las dos.
    const cajeroVenta = await buscar(PERSONAS.cajero, "E2", "A-2");
    afirmar(
      cajeroVenta.some((i) => i.number === "A-2"),
      "el cajero no encuentra la factura A-2",
    );
    const cajeroCompra = await buscar(PERSONAS.cajero, "E2", "LM-5501");
    afirmar(cajeroCompra.length === 0, `el cajero encontró ${cajeroCompra.length} compra(s)`);
    for (const q of ["A-2", "LM-5501"]) {
      const almacen = await buscar(PERSONAS.almacenista, "E2", q);
      afirmar(almacen.length === 0, `el almacenista encontró ${almacen.length} con «${q}»`);
    }

    // Acotada a la empresa de la pestaña: quien es dueño de E2 y E3 no ve en E2 lo de E3.
    const enE3 = await buscar(dueno, "E3", "F-89002");
    afirmar(
      enE3.some((i) => i.type === "purchase" && i.number === "F-89002"),
      "«F-89002» no se encuentra en E3, que es donde está",
    );
    const enE2 = await buscar(dueno, "E2", "F-89002");
    afirmar(enE2.length === 0, `la compra de E3 apareció buscando en E2 (${enE2.length})`);

    const corto = await pedir(dueno, "E2", "GET", "/v1/search/documents?q=A");
    afirmar(corto.status === 422, `una sola letra dio ${corto.status}`);

    // La pantalla: ni «Próximamente» ni asistente, y los documentos se piden al servidor.
    const fsP = await import("node:fs");
    const fuenteP = (ruta) =>
      fsP.readFileSync(new URL(`../../../apps/web/src/app/${ruta}`, import.meta.url), "utf8");
    const paleta = fuenteP("palette.tsx");
    afirmar(!/Próximamente/i.test(paleta), "la paleta sigue diciendo «Próximamente»");
    afirmar(!/Asistente/i.test(paleta), "la paleta sigue anunciando el asistente");
    afirmar(
      paleta.includes("/v1/search/documents"),
      "la paleta no busca documentos en el servidor",
    );
    const acciones = fuenteP("paleta-acciones.ts");
    afirmar(
      acciones.includes('"Cerrar caja"') && acciones.includes('"Nuevo cliente"'),
      "la paleta no ofrece «Cerrar caja» y «Nuevo cliente»",
    );
  },
);

// P-07 (ola 5): los reportes son consultas del servidor y cada uno cuadra con SU FUENTE.
c.caso(
  "P-07",
  "ventas ↔ libro de ventas, margen ↔ ventas, inventario ↔ kardex, IVA e IGTF ↔ lo ya calculado, cierres ↔ sus filas",
  async () => {
    const dueno = PERSONAS.duenoE2E3;
    const DESDE = "2026-01-01";
    const [{ hoy }] = await sql`select platform.caracas_day(now())::text as hoy`;
    const rango = `from=${DESDE}&to=${hoy}`;
    for (const e of ["E2", "E3"]) {
      const empresa = EMPRESAS[e];
      const rep = async (ruta) => {
        const r = await pedir(dueno, e, "GET", `/v1/reports/${ruta}`);
        afirmar(r.status === 200, `${e} · ${ruta} dio ${r.status}: ${r.texto.slice(0, 200)}`);
        return r.json;
      };
      const linea = (t, k) => t.summary.find((s) => s.key === k)?.value;

      // (1) Ventas con factura NO es el libro de ventas: el libro lleva además los retiros de
      // inventario (facturas de retiro, sus notas y las notas de retiro viejas) y las notas de
      // débito por IGTF. La conciliación se hace contra el libro ENTERO, sin filtrarlo con la
      // regla del reporte: ventas con factura + retiros del libro = total del libro (la nota de
      // débito por IGTF va en el libro con total de venta cero y lo percibido en su columna).
      const ventas = await rep(`sales?${rango}`);
      const [libro] = await sql`
        select round(coalesce(sum(total_amount), 0), 2)::text as total,
               round(coalesce(sum(total_amount) filter (where kind like 'withdrawal%'), 0), 2)::text
                 as retiros,
               round(coalesce(sum(igtf_percibido), 0), 2)::text as igtf,
               ${linea(ventas, "fiscal_total")}::numeric
                 + coalesce(sum(total_amount) filter (where kind like 'withdrawal%'), 0)
                 = coalesce(sum(total_amount), 0) as cuadra
          from platform.sales_book(${empresa}, ${DESDE}::date, ${hoy}::date)`;
      afirmar(
        libro.cuadra === true,
        `${e}: ventas con factura ${linea(ventas, "fiscal_total")} + retiros ${libro.retiros} ≠ libro ${libro.total}`,
      );
      // Con cifras distintas de cero donde el escenario las tenga: E3 percibió IGTF con nota. El
      // escenario RESTAURADO no trae retiros en el libro (el bloque I ensaya el retiro con la
      // vista previa para no gastar el papel de E2), así que aquí no se exigen: si los hay, que
      // el reporte no los cuente. Con retiros de verdad (factura de retiro y su nota dentro del
      // rango) lo asevera `apps/api/test/e2e-reportes-fiscales.test.ts`.
      if (Number(libro.retiros) !== 0) {
        afirmar(
          linea(ventas, "fiscal_total") !== libro.total,
          `${e}: «ventas con factura» coincide con el libro: está contando los retiros`,
        );
      }
      if (e === "E3") {
        afirmar(Number(libro.igtf) > 0, "E3: el escenario ya no tiene IGTF en el libro");
      }
      afirmar(
        ventas.summary.find((x) => x.key === "fiscal_total").label === "Ventas con factura",
        `${e}: la línea sigue diciendo que es lo que entra al libro`,
      );
      afirmar(Number(ventas.row_count) > 0, `${e}: el reporte de ventas no trae días`);
      // Los días suman el total, y cada agrupación por documento llega al mismo total.
      const [dias] = await sql`
        select (select sum(x::numeric) from unnest(${ventas.rows.map((x) => x.total)}::text[]) as x)
                 = ${ventas.totals.total}::numeric as cuadra`;
      afirmar(dias.cuadra === true, `${e}: los días no suman ${ventas.totals.total}`);
      for (const g of ["month", "customer", "seller"]) {
        const t = await rep(`sales?${rango}&group=${g}`);
        afirmar(
          t.totals.total === ventas.totals.total,
          `${e}: por ${g} da ${t.totals.total}, por día ${ventas.totals.total}`,
        );
      }
      const porProducto = await rep(`sales?${rango}&group=product`);
      afirmar(porProducto.rows.length > 0, `${e}: sin productos vendidos`);
      const porPago = await rep(`sales?${rango}&group=payment_method`);
      const [cobros] = await sql`
        select round(coalesce(sum(p.functional_amount), 0), 2)::text as t
          from public.payments p join public.documents d on d.id = p.document_id
         where p.company_id = ${empresa}
           and d.kind = any(${["invoice", "receipt", "debit_note"]}::text[])
           and platform.caracas_day(p.paid_at) between ${DESDE}::date and ${hoy}::date
           and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)`;
      afirmar(
        porPago.totals.collected === cobros.t,
        `${e}: cobrado ${porPago.totals.collected} ≠ cobros ${cobros.t}`,
      );

      // (2) Margen: su venta más la venta sin costo ES la base de lo vendido por producto; y el
      // diferencial es la misma cifra de su reporte de siempre.
      const margen = await rep(`margin?${rango}`);
      const [m] = await sql`
        select ${margen.totals.sales}::numeric + ${margen.totals.sales_without_cost}::numeric
                 = ${porProducto.totals.base}::numeric as cuadra,
               ${margen.totals.sales}::numeric - ${margen.totals.cost}::numeric
                 = ${margen.totals.margin}::numeric as resta`;
      afirmar(
        m.cuadra === true,
        `${e}: margen ${margen.totals.sales} + ${margen.totals.sales_without_cost} ≠ base ${porProducto.totals.base}`,
      );
      afirmar(m.resta === true, `${e}: venta − costo ≠ margen (${JSON.stringify(margen.totals)})`);
      const dif = await pedir(dueno, e, "GET", `/v1/reports/exchange-difference?${rango}`);
      const [d] = await sql`select round(${dif.json.neto}::numeric, 2)::text as n`;
      afirmar(
        linea(margen, "exchange_realized") === d.n,
        `${e}: diferencial ${linea(margen, "exchange_realized")} ≠ ${d.n}`,
      );
      const rev = margen.summary.find((s) => s.key === "exchange_revaluation");
      afirmar(rev.value === null && rev.reason === "sin_dato", `${e}: la revaluación se inventó`);

      // (3) IVA: cada período es su última corrida guardada, sin recalcular.
      const iva = await rep(`iva?${rango}`);
      const guardados = await sql`
        select distinct on (period_from, period_to) period_from::text as desde,
               round(cuota_a_pagar, 2)::text as pagar, round(debitos, 2)::text as debitos
          from public.iva_period_results
         where company_id = ${empresa} and period_to >= ${DESDE}::date
           and period_from <= ${hoy}::date
         order by period_from, period_to, created_at desc`;
      afirmar(
        iva.rows.length === guardados.length,
        `${e}: IVA ${iva.rows.length} ≠ ${guardados.length}`,
      );
      for (const g of guardados) {
        const fila = iva.rows.find((x) => x.period_from === g.desde);
        afirmar(
          fila?.payable === g.pagar && fila?.debits === g.debitos,
          `${e}: el período ${g.desde} no es el guardado`,
        );
      }

      // (4) Inventario valorizado: el total ES la suma de los saldos, y cuadra con el kardex
      // que el invariante compara con el mayor.
      const inv = await rep(`inventory?${rango}`);
      const [k] = await sql`
        select (select round(coalesce(sum(value), 0), 2)::text from public.stock_balances
                 where company_id = ${empresa}) as saldos,
               (select round(kardex, 2)::text from platform.inventory_ledger_gap(${empresa}))
                 as kardex`;
      afirmar(
        inv.totals.value === k.saldos,
        `${e}: valorizado ${inv.totals.value} ≠ saldos ${k.saldos}`,
      );
      afirmar(
        inv.totals.value === k.kardex,
        `${e}: valorizado ${inv.totals.value} ≠ kardex ${k.kardex}`,
      );

      // (6) Cierres de caja: cada cierre del rango, y la diferencia asentada.
      const cierres = await rep(`cash-closings?${rango}`);
      const [cc] = await sql`
        select count(*)::text as n, round(coalesce(sum(functional_amount), 0), 2)::text as dif
          from public.cash_closings
         where company_id = ${empresa}
           and closing_date between ${DESDE}::date and ${hoy}::date`;
      afirmar(String(cierres.row_count) === cc.n, `${e}: ${cierres.row_count} cierres ≠ ${cc.n}`);
      afirmar(
        cierres.totals.difference_functional === cc.dif,
        `${e}: diferencia ${cierres.totals.difference_functional} ≠ ${cc.dif}`,
      );
      const porCajero = await rep(`cash-closings?${rango}&group=cashier`);
      afirmar(
        porCajero.totals.difference_functional === cc.dif,
        `${e}: por cajero ${porCajero.totals.difference_functional} ≠ ${cc.dif}`,
      );

      // (7) IGTF: cada quincena es la cifra de la función única.
      const igtf = await rep(`igtf?${rango}`);
      afirmar(igtf.rows.length >= 2, `${e}: IGTF sin quincenas`);
      for (const q of igtf.rows) {
        const [f] = await sql`
          select round(total_functional, 2)::text as t
            from platform.igtf_period_totals(${empresa}, ${q.period_from}::date,
                                             ${q.period_to}::date)`;
        afirmar(q.perceived === f.t, `${e}: quincena ${q.period_from}: ${q.perceived} ≠ ${f.t}`);
      }
    }

    // Quién ve qué (RESPUESTA §2.8): el cajero no ve el dinero del negocio; el contador, IVA e
    // IGTF; el almacenista, existencias sin valor.
    for (const ruta of [
      `sales?${rango}`,
      `margin?${rango}`,
      `cash-closings?${rango}`,
      `iva?${rango}`,
    ]) {
      const r = await pedir(PERSONAS.cajero, "E2", "GET", `/v1/reports/${ruta}`);
      afirmar(r.status === 403, `el cajero abrió ${ruta} (${r.status})`);
    }
    for (const ruta of [`iva?${rango}`, `igtf?${rango}`, `sales?${rango}`]) {
      const r = await pedir(PERSONAS.contador, "E2", "GET", `/v1/reports/${ruta}`);
      afirmar(r.status === 200, `el contador no abre ${ruta} (${r.status})`);
    }
    const almacen = await pedir(
      PERSONAS.almacenista,
      "E2",
      "GET",
      `/v1/reports/inventory?${rango}`,
    );
    afirmar(almacen.status === 200, `el almacenista no abre el inventario (${almacen.status})`);
    afirmar(
      almacen.json.rows.length > 0 && almacen.json.rows.every((x) => x.value === null),
      "el almacenista recibió el valor del inventario",
    );
    afirmar(
      !almacen.json.columns.some((x) => x.key === "value") &&
        almacen.json.summary.every((s) => s.value === null),
      "el almacenista recibió cifras de dinero en el resumen",
    );
    const ventasAlmacen = await pedir(
      PERSONAS.almacenista,
      "E2",
      "GET",
      `/v1/reports/sales?${rango}`,
    );
    afirmar(ventasAlmacen.status === 403, `el almacenista abrió ventas (${ventasAlmacen.status})`);

    // La descarga la hace el servidor: CSV con «;», coma decimal y sin punto en las cifras.
    const csv = await pedir(
      dueno,
      "E2",
      "GET",
      `/v1/reports/sales?${rango}&group=month&format=csv`,
    );
    afirmar(csv.status === 200, `el CSV dio ${csv.status}`);
    const lineas = csv.texto.replace(/^﻿/, "").trim().split("\r\n");
    afirmar(lineas[0] === "Mes;Documentos;Sin impuesto;Impuesto;Total", `títulos: ${lineas[0]}`);
    afirmar(lineas.at(-1).startsWith("Total;"), `sin renglón de total: ${lineas.at(-1)}`);
    afirmar(
      lineas.slice(1).every((l) => /^[^;]+;\d+;-?\d+,\d{2};-?\d+,\d{2};-?\d+,\d{2}$/.test(l)),
      `el CSV no va en formato de Venezuela: ${lineas[1]}`,
    );

    // La pantalla no ofrece ningún reporte que el servidor no sirva.
    const fsR = await import("node:fs");
    const catalogo = fsR.readFileSync(
      new URL("../../../apps/web/src/pages/reportes/reporte.ts", import.meta.url),
      "utf8",
    );
    const claves = [...catalogo.matchAll(/clave: "([a-z-]+)",\n\s+titulo:/g)].map((x) => x[1]);
    afirmar(claves.length === 8, `el catálogo de la web trae ${claves.length} reportes`);
    for (const k of claves) {
      // Las carteras son «a hoy»: no llevan rango (y un parámetro de más es 422).
      const aHoy = k === "receivables" || k === "payables";
      const r = await pedir(dueno, "E2", "GET", `/v1/reports/${k}${aHoy ? "" : `?${rango}`}`);
      afirmar(r.status === 200, `la web ofrece «${k}» y el servidor responde ${r.status}`);
    }
  },
);

export default c.correr;

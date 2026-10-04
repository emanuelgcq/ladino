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

export default c.correr;

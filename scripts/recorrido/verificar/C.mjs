/**
 * Bloque C · Catálogo e importación. Comprobaciones de `pnpm recorrido C` (ver `_app.mjs`).
 *
 * ADR-0074 (la importación es un trabajo, no una petición):
 *   C-01: la importación leía «0.500» como 500 y «0.125» como 125, y terminaba en verde. Ahora,
 *         con el formato venezolano (el de omisión), la fila se rechaza como AMBIGUA con su número.
 *   C-04: una importación grande agotaba la petición y al reintentar duplicaba. Ahora la petición
 *         crea un TRABAJO; el mismo archivo devuelve el mismo trabajo y procesarlo no duplica.
 *   C-05: la existencia de un servicio se descartaba en silencio. Ahora sale como aviso en la
 *         vista previa.
 *
 * `_app.mjs` solo habla JSON; la importación es multipart, así que este bloque firma su propio
 * token con el mismo secreto de desarrollo y llama a la MISMA `app` en proceso.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { comprobaciones, afirmar, app, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { SignJWT } = await import(pathToFileURL(desdeApi.resolve("jose")).href);
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { procesarTrabajoImportacion } = await import(
  pathToFileURL(desdeApi.resolve("@ladino/domain")).href
);
const sqlApi = createClient("postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres");

const SECRETO = new TextEncoder().encode("super-secret-jwt-token-with-at-least-32-characters-long");
const EMISOR = "http://127.0.0.1:54321/auth/v1";
const TITULOS =
  "Nombre,Precio,Moneda,Código,Código de barras,Categoría,Existencia,Costo,Moneda costo,Es servicio";

async function idDe(correo) {
  const [fila] = await sql`select id from auth.users where email = ${correo}`;
  afirmar(fila, `no existe ${correo} en el escenario`);
  return fila.id;
}

/** Sube `csv` como multipart a `ruta`, como `correo`, en la empresa `empresa`. */
async function subir(correo, empresa, ruta, csv, numberFormat) {
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(await idDe(correo))
    .setIssuer(EMISOR)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(SECRETO);
  const form = new FormData();
  form.append("file", new File([csv], "recorrido.csv", { type: "text/csv" }));
  if (numberFormat) form.append("number_format", numberFormat);
  const r = await app.request(ruta, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Company-Id": EMPRESAS[empresa],
      // H4: confirmar exige Idempotency-Key; una llave por intento.
      ...(ruta.endsWith("/jobs") ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body: form,
  });
  const texto = await r.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    /* no JSON */
  }
  return { status: r.status, json, texto };
}

const c = comprobaciones("C");

c.caso(
  "C-01",
  "E3 · «Arandela plana 1/4,0.500,…,0.125» con el formato venezolano → rechazada como ambigua",
  async () => {
    const csv = `${TITULOS}\r\nArandela plana 1/4,0.500,USD,ARA-14,,Tornillería,1,0.125,USD,no\r\n`;
    const previa = await subir(PERSONAS.duenoE2E3, "E3", "/v1/products/import/preview", csv);
    afirmar(
      previa.status === 200,
      `la vista previa dio ${previa.status}: ${previa.texto.slice(0, 200)}`,
    );
    afirmar(
      previa.json.number_format === "comma_decimal",
      "el formato por omisión no es el venezolano",
    );
    const fila = previa.json.rows[0];
    afirmar(fila.row === 2 && fila.status === "rejected", `la fila 2 quedó ${fila.status}`);
    afirmar(fila.message.includes("ambiguo"), `el motivo no dice «ambiguo»: ${fila.message}`);
    // Y por el camino de siempre: la fila no entra como 500.
    const vieja = await subir(PERSONAS.duenoE2E3, "E3", "/v1/products/import", csv);
    afirmar(vieja.status === 201, `/v1/products/import dio ${vieja.status}`);
    afirmar(
      vieja.json.created === 0,
      `el camino de siempre creó ${vieja.json.created} producto(s)`,
    );
    // «0,500» con el mismo formato sí es 0,5.
    const bien = await subir(
      PERSONAS.duenoE2E3,
      "E3",
      "/v1/products/import/preview",
      `${TITULOS}\r\nArandela plana 1/4,"0,500",USD,ARA-14,,Tornillería,1,"0,125",USD,no\r\n`,
    );
    afirmar(
      bien.json.rows[0].price.amount === "0.5",
      `«0,500» dio ${bien.json.rows[0].price?.amount}`,
    );
  },
);

c.caso(
  "C-05",
  "E2 · «Transporte especial … 10 … sí» → la existencia del servicio sale como AVISO",
  async () => {
    const csv = `${TITULOS}\r\nTransporte especial,"50,00",USD,ERR-7,,Servicios,10,,,sí\r\n`;
    const previa = await subir(PERSONAS.duenoE2E3, "E2", "/v1/products/import/preview", csv);
    afirmar(
      previa.status === 200,
      `la vista previa dio ${previa.status}: ${previa.texto.slice(0, 200)}`,
    );
    const fila = previa.json.rows[0];
    afirmar(fila.status === "ready", `la fila quedó ${fila.status}: ${fila.message}`);
    afirmar(!fila.initial_stock, "el servicio trae existencia");
    const avisos = fila.warnings.join(" ");
    afirmar(avisos.includes("servicio") && avisos.includes("existencia"), `sin aviso: «${avisos}»`);
  },
);

c.caso(
  "C-04",
  "E2 · el mismo archivo dos veces → el MISMO trabajo; procesarlo y reimportar no duplica",
  async () => {
    // Contenido FIJO: correr el recorrido dos veces sobre la misma base reutiliza el trabajo.
    const csv = `${TITULOS}\r\nProducto del recorrido C-04,"1,00",USD,REC-C04,,Recorrido,,,,no\r\n`;
    const a = await subir(PERSONAS.duenoE2E3, "E2", "/v1/products/import/jobs", csv);
    afirmar(
      a.status === 202 || a.status === 200,
      `crear el trabajo dio ${a.status}: ${a.texto.slice(0, 200)}`,
    );
    const b = await subir(PERSONAS.duenoE2E3, "E2", "/v1/products/import/jobs", csv);
    afirmar(
      b.status === 200 && b.json.reused === true,
      `el reintento dio ${b.status} reused=${b.json?.reused}`,
    );
    afirmar(b.json.id === a.json.id, "el reintento creó un segundo trabajo");
    await procesarTrabajoImportacion(sqlApi, a.json.id, await idDe(PERSONAS.duenoE2E3));
    await procesarTrabajoImportacion(sqlApi, a.json.id, await idDe(PERSONAS.duenoE2E3));
    const [t] = await sql`
      select status, processed_rows, created_count + updated_count as hechos
        from public.product_import_jobs where id = ${a.json.id}`;
    afirmar(
      t.status === "done" && t.processed_rows === 1,
      `el trabajo quedó ${t.status}/${t.processed_rows}`,
    );
    const [n] = await sql`
      select count(*)::int as n from public.products
       where company_id = ${EMPRESAS.E2} and sku = 'REC-C04'`;
    afirmar(n.n === 1, `hay ${n.n} productos REC-C04`);
  },
);

// C-09 (ola 3): la foto se autoriza (permiso y producto) ANTES de procesarla y subirla.
c.caso(
  "C-09",
  "foto a un producto inventado: cajero → 403 y dueño → 404, antes del almacenamiento",
  async () => {
    const { pedir } = await import("./_app.mjs");
    const inventado = crypto.randomUUID();
    const cajero = await pedir(
      PERSONAS.cajero,
      "E2",
      "POST",
      `/v1/products/${inventado}/image`,
      {},
    );
    afirmar(cajero.status === 403, `cajero: esperaba 403, llegó ${cajero.status}`);
    const dueno = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "POST",
      `/v1/products/${inventado}/image`,
      {},
    );
    afirmar(dueno.status === 404, `dueño: esperaba 404, llegó ${dueno.status}`);
  },
);

// ── Ola 4 · C-02, C-03, C-10 y C-11 ─────────────────────────────────────────────
const fsC = await import("node:fs");
const fuente = (rel) => fsC.readFileSync(path.join(RAIZ, rel), "utf8");
const { pedir } = await import("./_app.mjs");

c.caso(
  "C-02",
  "administración abre la MISMA alta del primer día, y la API le acepta lo avanzado",
  async () => {
    const admin = fuente("apps/web/src/pages/catalogo/Productos.tsx");
    afirmar(
      /import \{ AltaSimple \} from "\.\.\/negocio\/Productos\.js"/.test(admin) &&
        admin.includes("<AltaSimple"),
      "Administración → Productos no usa el alta simple",
    );
    afirmar(
      !admin.includes("function NuevoProducto"),
      "sigue habiendo un segundo diálogo de alta en administración",
    );
    const alta = fuente("apps/web/src/pages/negocio/Productos.tsx");
    afirmar(
      alta.includes('label="Unidad"') && alta.includes("CLASIFICACION_DEL_PRODUCTO.etiqueta"),
      "el alta simple no trae lo avanzado (unidad y clasificación) en «Más detalles»",
    );
    // El servidor recibe la clasificación por el alta simple y la valida como el alta completa:
    // la adicional sin justificación se rechaza con el mensaje del caso de uso (no crea nada).
    const r = await pedir(PERSONAS.duenoE2E3, "E2", "POST", "/v1/products/simple", {
      company_id: EMPRESAS.E2,
      name: "Recorrido C-02 (no debe crearse)",
      price: { amount: "1.00", currency: "USD" },
      unit_code: "kg",
      tax_category_code: "gravado_adicional",
    });
    afirmar(r.status === 422, `esperaba 422, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    afirmar(
      String(r.json?.message).includes("art. 61"),
      `el rechazo no es el del caso de uso: ${r.json?.message}`,
    );
    const [n] = await sql`
      select count(*)::int as n from public.products
       where company_id = ${EMPRESAS.E2} and name = 'Recorrido C-02 (no debe crearse)'`;
    afirmar(n.n === 0, "el alta rechazada dejó un producto");
    // La pantalla ofrece lo que el servidor dice: la reducida no sale sin un literal (P-51).
    const cats = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/tax-categories");
    const [lit] = await sql`select count(*)::int as n from public.tax_reduced_rate_literals`;
    const reducida = cats.json.find((t) => t.code === "gravado_reducida");
    afirmar(
      reducida && reducida.offered_in_sales === lit.n > 0,
      `la reducida se ofrece=${reducida?.offered_in_sales} con ${lit.n} literal(es)`,
    );
    afirmar(
      /\.filter\(\(t\) => t\.offered_in_sales\)/.test(alta),
      "el alta ofrece clasificaciones que el servidor no marca como ofrecibles",
    );
    afirmar(
      alta.includes("no se podrá cambiar después"),
      "el alta ya no avisa de que el tipo (producto o servicio) no se cambia",
    );
  },
);

c.caso(
  "C-03",
  "E2 · un producto inactivo con existencia no sale en el mostrador ni en la caja; sí en inventario",
  async () => {
    const [pausado] = await sql`
      select p.id, p.name from public.products p
       where p.company_id = ${EMPRESAS.E2} and p.status = 'inactive' and p.system_code is null
         and exists (select 1 from public.stock_balances b
                      where b.product_id = p.id and b.quantity > 0)
       limit 1`;
    afirmar(pausado, "el escenario no tiene un producto inactivo con existencia en E2");
    const q = encodeURIComponent(pausado.name);
    // La consulta de la caja y la del mostrador (/productos): la misma, con only_active=1.
    const caja = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      `/v1/products?only_active=1&with_price=1&with_stock=1&per_page=60&search=${q}`,
    );
    afirmar(caja.status === 200, `la búsqueda de la caja dio ${caja.status}`);
    afirmar(
      !caja.json.items.some((i) => i.id === pausado.id),
      `«${pausado.name}», inactivo, sale en la búsqueda de la caja`,
    );
    const mostrador = fuente("apps/web/src/pages/negocio/Productos.tsx");
    const consultas = mostrador.match(/\/v1\/products\?[^`"]*with_price=1[^`"]*/g) ?? [];
    afirmar(consultas.length >= 2, "no encuentro las consultas de /productos");
    afirmar(
      consultas.every((u) => u.includes("only_active=1")),
      "/productos pide el catálogo sin only_active=1: enseña lo que no se vende",
    );
    // Sigue en inventario, con su estado y su existencia.
    const inventario = await pedir(
      PERSONAS.duenoE2E3,
      "E2",
      "GET",
      `/v1/products?with_stock=1&per_page=100&search=${q}`,
    );
    const fila = inventario.json.items.find((i) => i.id === pausado.id);
    afirmar(fila, "el inactivo desapareció del listado de inventario");
    afirmar(fila.status === "inactive", `el listado lo trae como ${fila.status}`);
    afirmar(Number(fila.stock_quantity) > 0, "el listado de inventario perdió su existencia");
    afirmar(
      fuente("apps/web/src/pages/negocio/Inventario.tsx").includes("Inactivo · no se vende"),
      "Inventario ya no marca el inactivo",
    );
    afirmar(
      fuente("apps/web/src/pages/catalogo/Productos.tsx").includes(
        "Seguirá en el inventario con su existencia",
      ),
      "inactivar con existencia ya no avisa",
    );
  },
);

c.caso("C-10", "la foto del producto se puede soltar, y el botón sigue eligiéndola", async () => {
  const alta = fuente("apps/web/src/pages/negocio/Productos.tsx");
  afirmar(
    alta.includes("onDrop=") && alta.includes("fotoSoltada(e)") && alta.includes("onDragOver="),
    "el recuadro de la foto del alta no acepta soltar un archivo",
  );
  afirmar(
    alta.includes("onClick={() => fotoRef.current?.click()}"),
    "el recuadro de la foto dejó de abrir el selector (teclado)",
  );
  afirmar(
    fuente("apps/web/src/pages/catalogo/Productos.tsx").includes("fotoSoltada(e)"),
    "la ficha del producto en administración no acepta soltar la foto",
  );
});

c.caso(
  "C-11",
  "E2 · cada precio del historial trae los Bs a la tasa de SU día (o dice por qué no) y la de hoy aparte",
  async () => {
    const listas = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/price-lists");
    afirmar(listas.status === 200 && listas.json.length > 0, "E2 no tiene listas de precios");
    let vistos = 0;
    for (const lista of listas.json) {
      const r = await pedir(PERSONAS.duenoE2E3, "E2", "GET", `/v1/price-lists/${lista.id}/prices`);
      afirmar(r.status === 200, `el historial de ${lista.name} dio ${r.status}`);
      for (const i of r.json.items) {
        vistos += 1;
        // La tasa que rige el día de Caracas del precio, preguntada aparte a la base.
        const [t] = await sql`
          select f.rate::text as rate, f.rate_date::text as rate_date,
                 platform.caracas_day(${i.effective_from}::timestamptz)
                   > platform.caracas_day(now()) as programado
            from (select 1) uno
            left join lateral platform.rate_for(${EMPRESAS.E2}, 'USD', 'VES',
                        platform.caracas_day(${i.effective_from}::timestamptz)) f on true`;
        if (t.programado) {
          afirmar(
            i.historical_rate_status === "scheduled" && i.historical_equivalent_amount === null,
            `un precio programado trae cifra histórica (${i.historical_equivalent_amount})`,
          );
        } else if (t.rate === null) {
          afirmar(
            i.historical_rate_status === "missing" && i.historical_equivalent_amount === null,
            `sin tasa ese día y la celda trae ${i.historical_equivalent_amount}`,
          );
        } else {
          afirmar(
            i.historical_rate_status === "available" &&
              i.historical_rate === t.rate &&
              i.historical_rate_date === t.rate_date,
            `el precio del ${i.effective_from} usa la tasa ${i.historical_rate} (${i.historical_rate_date}), y la de su día es ${t.rate} (${t.rate_date})`,
          );
          afirmar(i.historical_equivalent_amount !== null, "con tasa y sin cifra histórica");
        }
      }
    }
    afirmar(vistos > 0, "E2 no tiene ningún precio que mirar");
    const pantalla = fuente("apps/web/src/pages/catalogo/Precios.tsx");
    afirmar(
      pantalla.includes("historical_equivalent_amount") &&
        pantalla.includes("el día del precio") &&
        pantalla.includes("Hoy, como referencia"),
      "la pantalla de precios no separa los Bs del día del precio de la referencia de hoy",
    );
  },
);

// C-06 (ola 5): vender al mayor. El precio lo resuelve el SERVIDOR (lista de la venta → lista
// del cliente → lista de mostrador) y cambiar la lista de una venta exige
// `sales.price_list.override` en el servidor. No escribe nada: solo cotiza.
c.caso(
  "C-06",
  "el ajuste «Vendo al mayor» lo gobierna el dueño; la caja cotiza por la lista de mostrador y cambiarla exige el permiso en el servidor (el cajero, 403 con su mensaje)",
  async () => {
    const ajustes = await pedir(PERSONAS.duenoE2E3, "E2", "GET", "/v1/company-settings");
    afirmar(
      ajustes.status === 200 && typeof ajustes.json.sells_wholesale === "boolean",
      `los ajustes no traen «vendo al mayor»: ${ajustes.status} ${ajustes.texto.slice(0, 200)}`,
    );
    // El cajero no lo cambia (se le manda el MISMO valor: aunque pasara, no cambiaría nada).
    const cajeroAjusta = await pedir(PERSONAS.cajero, "E2", "PUT", "/v1/company-settings", {
      sells_wholesale: ajustes.json.sells_wholesale,
    });
    afirmar(cajeroAjusta.status === 403, `el cajero cambió los ajustes: ${cajeroAjusta.status}`);

    const [mostrador] = await sql`
      select l.id, l.name from public.price_lists l
       where l.company_id = ${EMPRESAS.E2} and l.status = 'active'
       order by (l.id = (select cs.default_price_list_id from public.company_settings cs
                          where cs.company_id = ${EMPRESAS.E2})) desc,
                (l.name = 'detal') desc, (l.name like 'detal%') desc, l.created_at
       limit 1`;
    const [otra] = await sql`
      select l.id, l.name from public.price_lists l
       where l.company_id = ${EMPRESAS.E2} and l.status = 'active' and l.id <> ${mostrador.id}
       order by (l.name like 'mayor%') desc, l.created_at limit 1`;
    afirmar(otra, "E2 no tiene una segunda lista activa: el escenario no es el del recorrido");
    const [producto] = await sql`
      select p.id, p.name from public.products p
       where p.company_id = ${EMPRESAS.E2} and p.status = 'active' and p.system_code is null
         and platform.price_at(${mostrador.id}, p.id, now()) is not null
       order by p.created_at limit 1`;
    afirmar(producto, "E2 no tiene un producto con precio de mostrador");
    const cotizar = (quien, extra) =>
      pedir(quien, "E2", "POST", "/v1/pos/quote", {
        company_id: EMPRESAS.E2,
        lines: [{ product_id: producto.id, quantity: "1" }],
        ...extra,
      });

    const sinPedir = await cotizar(PERSONAS.cajero, {});
    afirmar(
      sinPedir.status === 200 && sinPedir.json.price_list_id === mostrador.id,
      `sin cliente ni lista, la caja debía cotizar por «${mostrador.name}»: ${sinPedir.status} ${sinPedir.texto.slice(0, 200)}`,
    );
    const cajero = await cotizar(PERSONAS.cajero, { price_list_id: otra.id });
    afirmar(
      cajero.status === 403 && cajero.json.code === "PERMISSION_REQUIRED",
      `el cajero cotizó con otra lista: ${cajero.status} ${cajero.texto.slice(0, 200)}`,
    );
    afirmar(
      String(cajero.json.person_message ?? "").includes("cambiar la lista de precios de una venta"),
      `el 403 no dice qué no puede hacer: ${cajero.texto.slice(0, 300)}`,
    );
    // Pedir la misma que ya aplica no es cambiarla.
    const misma = await cotizar(PERSONAS.cajero, { price_list_id: mostrador.id });
    afirmar(misma.status === 200, `pedir la lista que ya aplica dio ${misma.status}`);

    // Quien puede: o cotiza por esa lista, o el producto no tiene precio en ella y se le DICE
    // (no cae en silencio a la de mostrador).
    const dueno = await cotizar(PERSONAS.duenoE2E3, { price_list_id: otra.id });
    if (dueno.status === 200) {
      afirmar(
        dueno.json.price_list_id === otra.id,
        `el dueño pidió «${otra.name}» y se cotizó por ${dueno.json.price_list_id}`,
      );
    } else {
      afirmar(
        dueno.status === 422 &&
          dueno.json.message.includes(`no tiene precio en la lista «${otra.name}»`) &&
          dueno.json.message.includes(producto.name),
        `sin precio en «${otra.name}» debía decirlo con el producto: ${dueno.status} ${dueno.texto.slice(0, 300)}`,
      );
    }
  },
);

// ── Ola 5 · C-07: el interruptor «lleva lote y vencimiento» existe y la llegada lo pide ──
// No escribe existencia: crea UN producto sin movimientos y solo intenta llegadas que se rechazan.
c.caso(
  "C-07",
  "E3 · un producto nace con lote y vencimiento, la llegada los pide con su nombre, y sin movimientos se apaga y se enciende",
  async () => {
    // EL PRODUCTO DE ESTA COMPROBACIÓN ES SIEMPRE EL MISMO (código fijo): con `--sin-restaurar`
    // no se acumula uno nuevo en cada corrida. Nunca tiene movimientos (sus llegadas se rechazan).
    const nombre = "Yogur del recorrido";
    const [existente] = await sql`
      select id, tracks_lots from public.products
       where company_id = ${EMPRESAS.E3} and sku = 'REC-C07-YOGUR'`;
    let id = existente?.id ?? null;
    if (id === null) {
      const alta = await pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/products/simple", {
        company_id: EMPRESAS.E3,
        sku: "REC-C07-YOGUR",
        name: nombre,
        price: { amount: "2", currency: "USD" },
        tracks_lots: true,
      });
      afirmar(alta.status === 201, `alta con lote y vencimiento: ${alta.status} ${alta.texto}`);
      id = alta.json.product.id;
    } else if (existente.tracks_lots !== true) {
      // Una corrida anterior murió con el interruptor apagado: se deja como recién creado.
      const r = await pedir(PERSONAS.duenoE2E3, "E3", "PATCH", `/v1/products/${id}`, {
        company_id: EMPRESAS.E3,
        tracks_lots: true,
      });
      afirmar(r.status === 200, `reencender el interruptor del producto reutilizado: ${r.status}`);
    }
    const ficha = await pedir(PERSONAS.duenoE2E3, "E3", "GET", `/v1/products/${id}`);
    afirmar(
      ficha.status === 200 && ficha.json.tracks_lots === true && ficha.json.tracks_expiry === true,
      `el producto no quedó con lote Y vencimiento: ${ficha.texto.slice(0, 300)}`,
    );

    const [deposito] = await sql`
      select id from public.warehouses
       where company_id = ${EMPRESAS.E3} and status = 'active' order by created_at limit 1`;
    afirmar(deposito, "E3 no tiene un depósito activo");
    const llegar = (extra) =>
      pedir(PERSONAS.duenoE2E3, "E3", "POST", "/v1/inventory/receipts", {
        origin: "aporte",
        company_id: EMPRESAS.E3,
        warehouse_id: deposito.id,
        product_id: id,
        quantity: "3",
        amount: "30",
        currency: "VES",
        ...extra,
      });
    const sinLote = await llegar({});
    afirmar(
      sinLote.status === 422 &&
        sinLote.json.message.includes(nombre) &&
        sinLote.json.message.includes("lleva lote y vencimiento"),
      `la llegada sin lote debía pedirlo con el nombre del producto: ${sinLote.status} ${sinLote.texto.slice(0, 300)}`,
    );
    const sinFecha = await llegar({ lot_code: `REC-${Date.now().toString(36)}` });
    afirmar(
      sinFecha.status === 422 && sinFecha.json.message.includes("la fecha en que vence"),
      `la llegada con lote y sin fecha debía pedir la fecha: ${sinFecha.status} ${sinFecha.texto.slice(0, 300)}`,
    );
    const [escrito] = await sql`
      select (select count(*)::int from public.inventory_moves where product_id = ${id}) as movs,
             (select count(*)::int from public.lots where product_id = ${id}) as lotes`;
    afirmar(
      escrito.movs === 0 && escrito.lotes === 0,
      `una llegada rechazada dejó algo escrito: ${JSON.stringify(escrito)}`,
    );

    // Sin movimientos, el interruptor es reversible (con ellos no: lo prueba el E2E).
    for (const valor of [false, true]) {
      const r = await pedir(PERSONAS.duenoE2E3, "E3", "PATCH", `/v1/products/${id}`, {
        company_id: EMPRESAS.E3,
        tracks_lots: valor,
      });
      afirmar(
        r.status === 200 && r.json.tracks_lots === valor && r.json.tracks_expiry === valor,
        `cambiar el interruptor a ${valor} sin movimientos: ${r.status} ${r.texto.slice(0, 300)}`,
      );
    }
  },
);

export default c.correr;
